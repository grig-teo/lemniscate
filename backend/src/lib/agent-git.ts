import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Task } from '@prisma/client';
import type { LlmChange } from './agent-prompts.js';
import { generateCommitMessage } from './agent-prompts.js';
import type { LlmRuntime, TokenSplit } from './agent-runtime.js';
import { prisma } from './prisma.js';
import { errorKind, logJobFailure } from './job-failure-log.js';
import { publishTaskEvent } from './task-events.js';
import { errorMessage, redactSecrets } from './utils.js';
import { archiveWorkdirToMinio } from './workdir-archive.js';
import { scrubAgentScratchFiles } from './workdir-scrub.js';

// Shared git/workdir/event plumbing for the agent-loop jobs (run-task,
// review-pr, generate-proposals). Extracted from agent-loop.ts.
//
// Security: decrypted tokens/keys live only in memory and in the env of the
// worker's own git child processes (LEMNISCATE_GIT_TOKEN, read by the inline
// credential helper below). Remote URLs stay tokenless — the workdir's
// .git/config is readable by the YOLO agent. Everything written to logs,
// task events, or the task.error field is passed through redactSecrets.

const execFileAsync = promisify(execFile);

const GIT_USER_NAME = 'lemniscate-agent';
const GIT_USER_EMAIL = 'agent@lemniscate.local';

// Env var carrying the provider token to the git child process. It is set
// ONLY here (worker's own git children); the hermes child env is an allowlist
// that excludes it (buildHermesEnv in hermes-runner.ts).
const GIT_TOKEN_ENV = 'LEMNISCATE_GIT_TOKEN';

export interface GitAuth {
  username: string;
  token: string;
}

// Per-invocation credential auth: an inline credential helper that echoes the
// username and reads the token from the child env. The token never appears in
// remote URLs (.git/config), never in argv (`ps`), never in log events.
function credentialArgs(auth: GitAuth): string[] {
  const helper = `!f() { echo "username=${auth.username}"; echo "password=$${GIT_TOKEN_ENV}"; }; f`;
  return ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`];
}

export interface GitOptions {
  cwd?: string;
  secrets?: string[];
  /** When set, every command echoes a redacted `$ git ...` log event. */
  taskId?: string;
  /** Per-invocation HTTP(S) credentials for clone/fetch/push. */
  auth?: GitAuth;
}

// Best-effort console echo of the command line; secrets are scrubbed before
// anything reaches the event stream, and logging never breaks the git op.
async function logGitCommand(args: string[], options: GitOptions): Promise<void> {
  if (!options.taskId) return;
  const line = redactSecrets(`$ git ${args.join(' ')}`, options.secrets ?? []);
  await logEvent(options.taskId, line).catch(() => {});
}

// Runs git; never echoes full args into the thrown error.
export async function git(args: string[], options: GitOptions = {}): Promise<string> {
  const argv = options.auth ? [...credentialArgs(options.auth), ...args] : args;
  await logGitCommand(argv, options);
  try {
    const { stdout } = await execFileAsync('git', argv, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.auth
        ? { env: { ...process.env, [GIT_TOKEN_ENV]: options.auth.token } }
        : {}),
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

import { withGitRetry } from './git-retry.js';

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

// Empty repositories have no branch to clone; detect that specific failure
// so the caller can fall back to initializing a fresh repo. Single home —
// agent-proposals uses it too.
export function isEmptyRepoCloneError(err: unknown): boolean {
  return (
    err instanceof Error && /Remote branch .+ not found|couldn't find remote ref/.test(err.message)
  );
}

export interface CloneResult {
  emptyRepo: boolean;
}

// A clone of a branchless (empty) remote cannot work; bootstrap a local
// repo on the default branch with origin set instead.
async function initEmptyRepository(
  workdir: string,
  cloneUrl: string,
  defaultBranch: string,
  secrets: string[],
  taskId?: string,
): Promise<void> {
  await fs.rm(workdir, { recursive: true, force: true });
  await fs.mkdir(workdir, { recursive: true });
  await git(['init', '-b', defaultBranch], { cwd: workdir, taskId });
  await git(['remote', 'add', 'origin', cloneUrl], { cwd: workdir, secrets, taskId });
  if (taskId) {
    await logEvent(taskId, 'remote is empty — initialized a fresh repository').catch(() => {});
  }
}

export async function cloneRepository(
  workdir: string,
  cloneUrl: string,
  defaultBranch: string,
  secrets: string[],
  options: { shallow?: boolean; taskId?: string; auth?: GitAuth } = {},
): Promise<CloneResult> {
  await fs.rm(workdir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(workdir), { recursive: true });
  const depthArgs = options.shallow === false ? [] : ['--depth', '1'];
  try {
    await withGitRetry(() =>
      git(['clone', ...depthArgs, '--branch', defaultBranch, cloneUrl, workdir], {
        secrets,
        taskId: options.taskId,
        ...(options.auth ? { auth: options.auth } : {}),
      }),
    );
  } catch (err) {
    if (!isEmptyRepoCloneError(err)) throw err;
    await initEmptyRepository(workdir, cloneUrl, defaultBranch, secrets, options.taskId);
    await git(['config', 'user.name', GIT_USER_NAME], { cwd: workdir, taskId: options.taskId });
    await git(['config', 'user.email', GIT_USER_EMAIL], { cwd: workdir, taskId: options.taskId });
    return { emptyRepo: true };
  }
  await git(['config', 'user.name', GIT_USER_NAME], { cwd: workdir, taskId: options.taskId });
  await git(['config', 'user.email', GIT_USER_EMAIL], { cwd: workdir, taskId: options.taskId });
  if (options.taskId) {
    await logEvent(options.taskId, `clone complete (${defaultBranch})`).catch(() => {});
  }
  return { emptyRepo: false };
}

export async function hasDirtyWorkdir(workdir: string): Promise<boolean> {
  return (await git(['status', '--porcelain'], { cwd: workdir })).trim() !== '';
}

// Shallow clone of the default branch plus the task branch fetched and
// checked out on top — the starting point for reviews, CI fixes, and any
// other job that works on an existing PR branch.
export async function checkoutTaskBranch(
  workdir: string,
  cloneUrl: string,
  defaultBranch: string,
  headBranch: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  await cloneRepository(workdir, cloneUrl, defaultBranch, secrets, { auth });
  await withGitRetry(() =>
    git(['fetch', '--depth', '1', 'origin', headBranch], { cwd: workdir, secrets, auth }),
  );
  await git(['checkout', '-b', headBranch, 'FETCH_HEAD'], { cwd: workdir });
}

export const logEvent = (taskId: string, line: string): Promise<void> =>
  publishTaskEvent(taskId, 'log', { line });

// Batched variant: emits multiple lines as a single TaskEvent to reduce DB
// write pressure during agent runs. Payload shape: { lines: string[] }.
export const logBatch = (taskId: string, lines: string[]): Promise<void> =>
  publishTaskEvent(taskId, 'log', { lines });

// Persists cumulative LLM usage so maxTokensPerRun spans every job of a task
// (run-task plus review/fix iterations), not just one job's runtime. The
// prompt/completion split rides along when the runtime is known; jobs that
// never built a runtime leave the stored split untouched.
export async function persistTokenUsage(
  taskId: string,
  usedTokens: number,
  split?: TokenSplit,
): Promise<void> {
  await prisma.task
    .update({
      where: { id: taskId },
      data: {
        llmTokensUsed: usedTokens,
        ...(split
          ? { llmPromptTokens: split.promptTokens, llmCompletionTokens: split.completionTokens }
          : {}),
      },
    })
    .catch(() => {});
}

export async function cleanupWorkdir(workdir: string, taskId?: string): Promise<void> {
  // Snapshot to MinIO first (silent, best-effort) so a finished task's
  // workdir stays retrievable after the local copy is gone. taskId is
  // forwarded so the size-skip path can record an 'archive_skipped_size'
  // marker event on the task's console.
  await archiveWorkdirToMinio(workdir, taskId).catch(() => {});
  await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  if (taskId) await logEvent(taskId, 'cleaned up workdir').catch(() => {});
}

// Orphaned-workdir sweep planning lives in workdir-sweep.ts; re-exported so
// existing importers (worker.ts, tests) keep one import path.
export { planWorkdirSweep } from './workdir-sweep.js';

// Appends an actionable hint to known git-host push rejections so the task
// console tells the user how to fix it instead of showing raw stderr only.
export function explainGitFailure(message: string): string {
  if (/without `workflow` scope|refusing to allow an OAuth App to create or update workflow/i.test(message)) {
    return (
      `${message}\n` +
      `hint: the task touched .github/workflows and the GitHub token lacks the 'workflow' OAuth scope — ` +
      `reconnect the GitHub connection to grant it, then rerun the task.`
    );
  }
  return message;
}

// Logs a job failure as one structured JSON line (and to the task's event
// stream, both best-effort scrubbed). Returns the sanitized message for
// status updates. The user-facing notification goes through logJobFailure
// only — the single failure funnel (AGENTS.md §6) — and is awaited so the
// notification row exists before callers rethrow: the worker 'failed' hook
// funnels the same throw through logJobFailure again, and the sequential
// unread dedupe (notifyOncePerTask) then prevents a duplicate instead of
// racing a concurrent fire-and-forget flow.
export async function recordJobFailure(
  jobKind: string,
  taskId: string,
  err: unknown,
  secrets: string[],
): Promise<string> {
  const message = explainGitFailure(redactSecrets(errorMessage(err), secrets)).slice(0, 1_000);
  await logJobFailure({ jobName: jobKind, taskId, errorKind: errorKind(err), message });
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
  auth?: GitAuth,
): Promise<void> {
  const commitMessage = await generateCommitMessage(rt, task, summary);
  // Review verdicts / transcripts are agent scratch, never repo content.
  await scrubAgentScratchFiles(workdir);
  await git(['add', '-A'], { cwd: workdir, taskId: task.id });
  await git(['commit', '-m', commitMessage], { cwd: workdir, taskId: task.id });
  await logEvent(task.id, `committed: ${commitMessage}`);
  await git(pushArgs, { cwd: workdir, secrets, taskId: task.id, ...(auth ? { auth } : {}) });
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
    const diff = (await git(['diff', '--', rel], { cwd: workdir, secrets, taskId })).trim();
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
