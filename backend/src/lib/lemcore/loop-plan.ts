// Plan-mode + awaiting-approval persistence for the lemcore loop.
//
// Repo memory lives at <workdir>/.lemniscate/memory.md (gitignored there).
// Everything else is Redis-backed with a .lemniscate file fallback so the
// pause/decision flow still works when REDIS_URL is unset (dev, tests):
// * plan decision (approve/reject) + steering queue — pending-* json files
// * verification + nudge counters                     — run-state.json

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { getRedisClient } from '../redis.js';

export interface PlanDecision {
  decision: 'approve' | 'reject';
  comment?: string;
}

const STATE_DIR = '.lemniscate';
export const MEMORY_FILE = 'memory.md';
export const MEMORY_MAX_CHARS = 4_000;
const PLAN_TIMEOUT_MS = 60 * 60 * 1_000;
const DECISION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_VERIFY_NUDGES = 2;
const REDIS_TTL_SEC = 7 * 24 * 60 * 60;

const redisKey = (taskId: string, suffix: string) => `lemcore:task:${taskId}:${suffix}`;

function lemniscateDir(workdir: string): string {
  return path.join(workdir, STATE_DIR);
}

// In-memory last resort for the (test) case where neither Redis nor a
// workdir is usable; keyed by task so parallel runs never share state.
const memStore = new Map<string, string>();

async function readJson<T>(workdir: string, file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(lemniscateDir(workdir), file), 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(workdir: string, file: string, value: unknown): Promise<void> {
  await fs.mkdir(lemniscateDir(workdir), { recursive: true });
  await fs.writeFile(path.join(lemniscateDir(workdir), file), JSON.stringify(value));
}

async function removeFile(workdir: string, file: string): Promise<void> {
  await fs.rm(path.join(lemniscateDir(workdir), file), { force: true });
}

// --- steering queue ---------------------------------------------------------

async function popSteerFile(workdir: string): Promise<string[]> {
  const queued = (await readJson<string[]>(workdir, 'pending-steer.json')) ?? [];
  await removeFile(workdir, 'pending-steer.json');
  return queued;
}

/** Drain queued steering messages (newest last). */
export async function drainSteerQueue(taskId: string, workdir: string): Promise<string[]> {
  try {
    const client = getRedisClient();
    const key = redisKey(taskId, 'steer');
    const items = await client.lrange(key, 0, -1);
    if (items.length > 0) await client.del(key);
    return items;
  } catch {
    try {
      return await popSteerFile(workdir);
    } catch {
      const items = memStore.has(redisKey(taskId, 'steer'))
        ? (JSON.parse(memStore.get(redisKey(taskId, 'steer'))!) as string[])
        : [];
      memStore.delete(redisKey(taskId, 'steer'));
      return items;
    }
  }
}

/** Queue one steering message; appended to the run's transcript next round. */
export async function enqueueSteer(taskId: string, workdir: string, message: string): Promise<void> {
  const key = redisKey(taskId, 'steer');
  try {
    const client = getRedisClient();
    await client.rpush(key, message);
    await client.expire(key, REDIS_TTL_SEC);
  } catch {
    try {
      const queued = (await readJson<string[]>(workdir, 'pending-steer.json')) ?? [];
      await writeJson(workdir, 'pending-steer.json', [...queued, message]);
    } catch {
      const queued = memStore.has(key) ? (JSON.parse(memStore.get(key)!) as string[]) : [];
      memStore.set(key, JSON.stringify([...queued, message]));
    }
  }
}

// --- plan / tool-approval decisions -----------------------------------------

// Decisions are written by the API route (possibly another process); poll.
async function waitFor<T>(
  timeoutMs: number,
  label: string,
  read: () => Promise<T | null>,
): Promise<T | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      logger.warn({ label }, 'lemcore: timed out waiting for a user decision');
      return 'timeout';
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Blocks until the plan is decided. Returns null on timeout (→ run fails). */
export async function waitForPlanDecision(
  taskId: string,
  workdir: string,
): Promise<PlanDecision | null> {
  const file = 'pending-plan-decision.json';
  const key = redisKey(taskId, 'plan-decision');
  const result = await waitFor(PLAN_TIMEOUT_MS, 'plan', async () => {
    try {
      const raw = await getRedisClient().getdel(key);
      return raw ? (JSON.parse(raw) as PlanDecision) : null;
    } catch {
      const fromFile = await readJson<PlanDecision>(workdir, file);
      if (fromFile) await removeFile(workdir, file);
      return fromFile ?? (memStore.has(key) ? JSON.parse(memStore.get(key)!) : null);
    }
  });
  if (result !== 'timeout') memStore.delete(key);
  return result === 'timeout' ? null : result;
}

/** Blocks until a mutating tool call is approved/denied. */
export async function waitForStepDecision(
  taskId: string,
  workdir: string,
  stepId: string,
): Promise<'approve' | 'deny' | null> {
  const key = redisKey(taskId, `decision:${stepId}`);
  const file = `pending-decision-${stepId}.json`;
  const result = await waitFor(DECISION_TIMEOUT_MS, `step ${stepId}`, async () => {
    try {
      return await getRedisClient().getdel(key);
    } catch {
      const fromFile = await readJson<string>(workdir, file);
      if (fromFile) await removeFile(workdir, file);
      return fromFile ?? memStore.get(key) ?? null;
    }
  });
  memStore.delete(key);
  if (result === 'timeout') return null;
  return result === 'approve' ? 'approve' : 'deny';
}

/** API entry point: record a plan decision for a paused run. */
export async function recordPlanDecision(
  taskId: string,
  workdir: string,
  decision: PlanDecision,
): Promise<void> {
  await put(redisKey(taskId, 'plan-decision'), workdir, 'pending-plan-decision.json', decision);
}

/** API entry point: record a tool approval/denial for a paused run. */
export async function recordStepDecision(
  taskId: string,
  workdir: string,
  stepId: string,
  decision: 'approve' | 'deny',
): Promise<void> {
  await put(redisKey(taskId, `decision:${stepId}`), workdir, `pending-decision-${stepId}.json`, decision);
}

async function put(key: string, workdir: string, file: string, value: unknown): Promise<void> {
  const raw = JSON.stringify(value);
  try {
    await getRedisClient().set(key, raw, 'EX', REDIS_TTL_SEC);
  } catch {
    try {
      await writeJson(workdir, file, value);
    } catch {
      memStore.set(key, raw);
    }
  }
}

// --- verification + nudge counters ------------------------------------------

interface RunState {
  verificationPassed?: boolean;
  verifyNudges?: number;
}

async function readState(taskId: string, workdir: string): Promise<RunState> {
  try {
    const raw = await getRedisClient().get(redisKey(taskId, 'state'));
    return raw ? (JSON.parse(raw) as RunState) : {};
  } catch {
    return (await readJson<RunState>(workdir, 'run-state.json')) ?? {};
  }
}

async function writeState(taskId: string, workdir: string, state: RunState): Promise<void> {
  try {
    await getRedisClient().set(redisKey(taskId, 'state'), JSON.stringify(state), 'EX', REDIS_TTL_SEC);
  } catch {
    await writeJson(workdir, 'run-state.json', state);
  }
}

export async function markVerificationPassed(taskId: string, workdir: string): Promise<void> {
  const state = await readState(taskId, workdir);
  await writeState(taskId, workdir, { ...state, verificationPassed: true });
}

export async function hasVerificationPassed(taskId: string, workdir: string): Promise<boolean> {
  return (await readState(taskId, workdir)).verificationPassed === true;
}

/** Counts one "run the checks first" nudge; false once the cap is reached. */
export async function consumeVerifyNudge(taskId: string, workdir: string): Promise<boolean> {
  const state = await readState(taskId, workdir);
  const nudges = state.verifyNudges ?? 0;
  if (nudges >= MAX_VERIFY_NUDGES) return false;
  await writeState(taskId, workdir, { ...state, verifyNudges: nudges + 1 });
  return true;
}

/** Drops all pause/state keys for a run (new run, resume, terminal state). */
export async function clearRunState(taskId: string, workdir: string): Promise<void> {
  const keys = ['steer', 'plan-decision', 'state'].map((s) => redisKey(taskId, s));
  try {
    await getRedisClient().del(...keys);
  } catch {
    // file fallback below
  }
  for (const key of keys) memStore.delete(key);
  for (const file of ['pending-steer.json', 'pending-plan-decision.json', 'run-state.json']) {
    await removeFile(workdir, file);
  }
}

// --- repo memory ------------------------------------------------------------

/** Appends one learning to .lemniscate/memory.md (created gitignored). */
export async function appendRepoMemory(workdir: string, learning: string): Promise<void> {
  const line = `- ${learning.replace(/\s+/g, ' ').trim()}`;
  await ensureGitignored(workdir);
  await fs.mkdir(lemniscateDir(workdir), { recursive: true });
  await fs.appendFile(path.join(lemniscateDir(workdir), MEMORY_FILE), `${line}\n`, 'utf8');
}

/** Memory file contents for system-prompt injection, newest kept under 4k. */
export async function loadRepoMemory(workdir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(lemniscateDir(workdir), MEMORY_FILE), 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed.length <= MEMORY_MAX_CHARS ? trimmed : trimmed.slice(-MEMORY_MAX_CHARS);
  } catch {
    return null;
  }
}

// The memory file must never be committed by the agent's git add -A.
async function ensureGitignored(workdir: string): Promise<void> {
  const gitignore = path.join(workdir, '.gitignore');
  try {
    const existing = await fs.readFile(gitignore, 'utf8');
    if (existing.split('\n').some((l) => l.trim() === `${STATE_DIR}/`)) return;
    await fs.appendFile(gitignore, `\n# lemcore run state + repo memory\n${STATE_DIR}/\n`);
  } catch {
    await fs.writeFile(gitignore, `# lemcore run state + repo memory\n${STATE_DIR}/\n`);
  }
}
