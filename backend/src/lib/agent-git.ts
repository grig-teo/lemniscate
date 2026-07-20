import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Task } from '@prisma/client';
import type { LlmChange } from './agent-prompts.js';
import { generateCommitMessage } from './agent-prompts.js';
import type { LlmRuntime } from './agent-runtime.js';
import { prisma } from './prisma.js';
import { publishTaskEvent } from './task-events.js';
import { errorMessage, redactSecrets } from './utils.js';

// Shared git/workdir/event plumbing for the agent-loop jobs (run-task,
// review-pr, generate-proposals). Extracted from agent-loop.ts.
//
// Security: decrypted tokens/keys live only in memory (and in the local git
// remote URL inside the throwaway workdir). Everything written to logs, task
// events, or the task.error field is passed through redactSecrets.

const execFileAsync = promisify(execFile);

const GIT_USER_NAME = 'lemniscate-agent';
const GIT_USER_EMAIL = 'agent@lemniscate.local';

// Runs git; never echoes full args (clone/push args may carry credentialed
// URLs) into the thrown error.
export async function git(
  args: string[],
  options: { cwd?: string; secrets?: string[] } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { message?: string; stderr?: string };
    const detail = (e.stderr || e.message || String(err)).trim();
    throw new Error(
      redactSecrets(`git ${args[0] ?? ''} failed: ${detail.slice(0, 500)}`, options.secrets ?? []),
    );
  }
}

export function sanitizeRelativePath(rawPath: string): string {
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
  if (
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized === '.' ||
    normalized === '.git' ||
    normalized.startsWith('.git/')
  ) {
    throw new Error(`LLM proposed an unsafe file path: ${rawPath}`);
  }
  return normalized;
}

export async function cloneRepository(
  workdir: string,
  cloneUrl: string,
  defaultBranch: string,
  secrets: string[],
  options: { shallow?: boolean } = {},
): Promise<void> {
  await fs.rm(workdir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(workdir), { recursive: true });
  const depthArgs = options.shallow === false ? [] : ['--depth', '1'];
  await git(['clone', ...depthArgs, '--branch', defaultBranch, cloneUrl, workdir], { secrets });
  await git(['config', 'user.name', GIT_USER_NAME], { cwd: workdir });
  await git(['config', 'user.email', GIT_USER_EMAIL], { cwd: workdir });
}

export async function hasDirtyWorkdir(workdir: string): Promise<boolean> {
  return (await git(['status', '--porcelain'], { cwd: workdir })).trim() !== '';
}

export const logEvent = (taskId: string, line: string): Promise<void> =>
  publishTaskEvent(taskId, 'log', { line });

// Persists cumulative LLM usage so maxTokensPerRun spans every job of a task
// (run-task plus review/fix iterations), not just one job's runtime.
export async function persistTokenUsage(taskId: string, usedTokens: number): Promise<void> {
  await prisma.task
    .update({ where: { id: taskId }, data: { llmTokensUsed: usedTokens } })
    .catch(() => {});
}

export async function cleanupWorkdir(workdir: string): Promise<void> {
  await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
}

// Logs a job failure to the console and the task's event stream (both
// best-effort scrubbed). Returns the sanitized message for status updates.
export async function recordJobFailure(
  jobKind: string,
  taskId: string,
  err: unknown,
  secrets: string[],
): Promise<string> {
  const message = redactSecrets(errorMessage(err), secrets).slice(0, 1_000);
  console.error(`${jobKind} ${taskId} failed:`, message);
  await logEvent(taskId, `error: ${message}`).catch(() => {});
  return message;
}

// Commits all pending changes and pushes with the given args. The LLM-written
// commit message degrades to a fallback when the call fails.
export async function commitAndPush(
  task: Task,
  rt: LlmRuntime,
  workdir: string,
  summary: string,
  pushArgs: string[],
  secrets: string[],
): Promise<void> {
  const commitMessage = await generateCommitMessage(rt, task, summary);
  await git(['add', '-A'], { cwd: workdir });
  await git(['commit', '-m', commitMessage], { cwd: workdir });
  await logEvent(task.id, `committed: ${commitMessage}`);
  await git(pushArgs, { cwd: workdir, secrets });
}

// ---------------------------------------------------------------------------
// Change application (one diff event per file)
// ---------------------------------------------------------------------------

async function applyDelete(taskId: string, abs: string, rel: string): Promise<void> {
  await fs.rm(abs, { force: true });
  await publishTaskEvent(taskId, 'diff', { path: rel, action: 'deleted' });
}

async function publishWriteDiff(
  taskId: string,
  workdir: string,
  rel: string,
  action: LlmChange['action'],
  content: string,
  secrets: string[],
): Promise<void> {
  if (action === 'modify') {
    const diff = (await git(['diff', '--', rel], { cwd: workdir, secrets })).trim();
    await publishTaskEvent(taskId, 'diff', {
      path: rel,
      diff: diff || `updated ${rel} (no textual diff available)`,
    });
    return;
  }
  const preview =
    content.length > 4_000 ? `${content.slice(0, 4_000)}\n… [truncated]` : content;
  await publishTaskEvent(taskId, 'diff', {
    path: rel,
    diff: `--- /dev/null\n+++ b/${rel}\n${preview}`,
  });
}

async function applyOneChange(
  taskId: string,
  workdir: string,
  change: LlmChange,
  secrets: string[],
): Promise<boolean> {
  const rel = sanitizeRelativePath(change.path);
  const abs = path.join(workdir, rel);
  if (change.action === 'delete') {
    await applyDelete(taskId, abs, rel);
    return true;
  }
  if (change.content === undefined) {
    await publishTaskEvent(taskId, 'log', {
      line: `skipping ${change.action} of ${rel}: LLM omitted file content`,
    });
    return false;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, change.content, 'utf8');
  await publishWriteDiff(taskId, workdir, rel, change.action, change.content, secrets);
  return true;
}

// Applies the LLM's changes to the workdir, emitting one diff event per file.
// Returns the number of files actually changed.
export async function applyChanges(
  taskId: string,
  workdir: string,
  changes: LlmChange[],
  secrets: string[],
): Promise<number> {
  let applied = 0;
  for (const change of changes) {
    if (await applyOneChange(taskId, workdir, change, secrets)) applied += 1;
  }
  return applied;
}
