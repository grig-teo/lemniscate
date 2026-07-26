import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  checkoutTaskBranch,
  cleanupWorkdir,
  cloneRepository,
  commitAndPush,
  git,
  hasDirtyWorkdir,
  logEvent,
  persistTokenUsage,
  recordJobFailure,
  sanitizeRelativePath,
  type GitAuth,
} from './agent-git.js';
import {
  llmCall,
  loadTaskWithRepo,
  prepareAgentRuntime,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { runHermesTask } from './hermes-runner.js';
import { enqueueMergeGate } from './proposal-scheduler.js';
import { mergePullRequest, pullRequestChecksStatus, type PrChecksStatus } from './pull-requests.js';
import {
  buildConflictResolutionMessages,
  buildHermesCiFixPrompt,
  buildHermesConflictPrompt,
  hasConflictMarkers,
  parseResolvedFile,
} from './pr-review.js';
import { publishTaskEvent, setTaskStatus } from './task-events.js';

// Job: merge-gate — owns the PR after the review passes on an auto-merge
// repository. The PR merges ONLY when provider CI checks are green:
//   pending  → re-enqueue with a delay and check again (bounded, ~30 min)
//   failing  → the hermes agent fixes the branch first, then re-check
//   conflict → resolve (hermes or direct LLM), push, and wait for CI on the
//              resolution commit before the next merge attempt
// Providers without a checks API (e.g. GitVerse) merge unverified, as before.

export const MERGE_GATE_DELAY_MS = 60_000;
// ~30 minutes of pending CI at the 60s re-check cadence.
export const MERGE_GATE_MAX_ATTEMPTS = 30;
export const MAX_CI_FIX_ATTEMPTS = 3;
const MAX_CONFLICT_FILE_CHARS = 40_000;

function hermesLlm(rt: LlmRuntime) {
  return {
    baseUrl: rt.cfg.baseUrl,
    apiKey: rt.apiKey,
    model: rt.cfg.model,
    contextWindow: rt.cfg.contextWindow,
  };
}

// ---------------------------------------------------------------------------
// CI fix (hermes)
// ---------------------------------------------------------------------------

async function runCiFixViaHermes(
  task: TaskWithRepo,
  rt: LlmRuntime,
  headBranch: string,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  await checkoutTaskBranch(
    workdir,
    cloneUrl,
    task.repository.defaultBranch,
    headBranch,
    secrets,
    auth,
  );
  await runHermesTask({
    workdir,
    prompt: buildHermesCiFixPrompt({
      taskTitle: task.title,
      baseBranch: task.repository.defaultBranch,
      headBranch,
      systemPromptExtra: rt.cfg.systemPromptExtra,
    }),
    llm: hermesLlm(rt),
    taskId: task.id,
    secrets,
    timeoutMs: config.AGENT_HERMES_TIMEOUT_MINUTES * 60_000,
  });
  if (!(await hasDirtyWorkdir(workdir))) {
    await logEvent(task.id, 'hermes produced no CI fix changes');
    return;
  }
  await commitAndPush(
    task,
    rt,
    workdir,
    'fix failing CI checks',
    ['push', 'origin', headBranch],
    secrets,
    auth,
  );
  await logEvent(task.id, `pushed CI fixes to ${headBranch}`);
}

// ---------------------------------------------------------------------------
// Merge with conflict resolution
// ---------------------------------------------------------------------------

// Merges FETCH_HEAD locally; returns the conflicted paths ([] on clean merge).
async function mergeHeadBranch(workdir: string): Promise<string[]> {
  try {
    await git(['merge', '--no-edit', 'FETCH_HEAD'], { cwd: workdir });
    return [];
  } catch {
    const output = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: workdir });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }
}

async function resolveConflictedFile(
  task: TaskWithRepo,
  rt: LlmRuntime,
  headBranch: string,
  workdir: string,
  relPath: string,
): Promise<void> {
  const rel = sanitizeRelativePath(relPath);
  const abs = path.join(workdir, rel);
  const conflictedContent = await fs.readFile(abs, 'utf8');
  if (conflictedContent.length > MAX_CONFLICT_FILE_CHARS) {
    throw new Error(`conflicted file ${rel} is too large for LLM resolution`);
  }
  const resolved = parseResolvedFile(
    await llmCall(
      rt,
      buildConflictResolutionMessages({
        path: rel,
        conflictedContent,
        baseBranch: task.repository.defaultBranch,
        headBranch,
        systemPromptExtra: rt.cfg.systemPromptExtra,
      }),
    ),
  );
  await fs.writeFile(abs, resolved, 'utf8');
  await git(['add', '--', rel], { cwd: workdir });
  await publishTaskEvent(task.id, 'diff', { path: rel, action: 'conflict-resolved' });
  await logEvent(task.id, `resolved conflict in ${rel}`);
}

// One conflict-resolution round: merge the head branch into a local checkout
// of the base branch, let the LLM rewrite each conflicted file, commit, and
// push the merge commit to the PR head branch (a fast-forward there, since
// the old head is the merge commit's second parent).
async function resolveMergeConflictsOnce(
  task: TaskWithRepo,
  rt: LlmRuntime,
  headBranch: string,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  // Full clone: a shallow one lacks the common ancestor a real merge needs.
  await cloneRepository(workdir, cloneUrl, task.repository.defaultBranch, secrets, {
    shallow: false,
    auth,
  });
  await git(['fetch', 'origin', headBranch], { cwd: workdir, secrets, auth });
  const conflicted = await mergeHeadBranch(workdir);
  for (const rel of conflicted) {
    await resolveConflictedFile(task, rt, headBranch, workdir, rel);
  }
  if (conflicted.length > 0) {
    await git(['commit', '-m', 'resolve merge conflicts'], { cwd: workdir });
  } else {
    await logEvent(task.id, 'merge applied cleanly locally; publishing the merge');
  }
  await git(['push', 'origin', `HEAD:${headBranch}`], { cwd: workdir, secrets, auth });
}

// Hermes variant: the agent rewrites every conflicted file inside the merge
// checkout; staging, marker verification, commit, and push stay external.
async function resolveMergeConflictsViaHermes(
  task: TaskWithRepo,
  rt: LlmRuntime,
  headBranch: string,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  // Full clone: a shallow one lacks the common ancestor a real merge needs.
  await cloneRepository(workdir, cloneUrl, task.repository.defaultBranch, secrets, {
    shallow: false,
    auth,
  });
  await git(['fetch', 'origin', headBranch], { cwd: workdir, secrets, auth });
  const conflicted = await mergeHeadBranch(workdir);
  if (conflicted.length === 0) {
    await logEvent(task.id, 'merge applied cleanly locally; publishing the merge');
  } else {
    await logEvent(
      task.id,
      `resolving ${conflicted.length} conflicted file(s) with the hermes agent`,
    );
    await runHermesTask({
      workdir,
      prompt: buildHermesConflictPrompt({
        baseBranch: task.repository.defaultBranch,
        headBranch,
        conflictedPaths: conflicted,
        systemPromptExtra: rt.cfg.systemPromptExtra,
      }),
      llm: hermesLlm(rt),
      taskId: task.id,
      secrets,
      timeoutMs: config.AGENT_HERMES_TIMEOUT_MINUTES * 60_000,
    });
    for (const rel of conflicted) {
      const content = await fs.readFile(path.join(workdir, sanitizeRelativePath(rel)), 'utf8');
      if (hasConflictMarkers(content)) {
        throw new Error(`hermes left conflict markers in ${rel}`);
      }
      await git(['add', '--', rel], { cwd: workdir });
      await publishTaskEvent(task.id, 'diff', { path: rel, action: 'conflict-resolved' });
      await logEvent(task.id, `resolved conflict in ${rel}`);
    }
    await git(['commit', '-m', 'resolve merge conflicts'], { cwd: workdir });
  }
  await git(['push', 'origin', `HEAD:${headBranch}`], { cwd: workdir, secrets, auth });
}

// One merge attempt. On conflict the branch is resolved and pushed, then the
// gate re-enqueues — CI must pass on the resolution commit before the next
// merge attempt (this is how a broken resolution never reaches main).
async function mergeWithConflictResolution(
  task: TaskWithRepo,
  rt: LlmRuntime,
  headBranch: string,
  attempt: number,
  ciFixes: number,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  const result = await mergePullRequest(task.repository.connection, {
    repoFullName: task.repository.fullName,
    headBranch,
    baseBranch: task.repository.defaultBranch,
  });
  if (result.merged) {
    await logEvent(task.id, `merged pull request: ${result.prUrl}`);
    await setTaskStatus(task.id, 'done');
    // The task's run workdir was kept for the review window — merged means
    // it is no longer needed.
    await cleanupWorkdir(path.join(config.AGENT_WORKDIR, task.id), task.id);
    return;
  }
  if (!result.conflict || attempt >= MERGE_GATE_MAX_ATTEMPTS) {
    await logEvent(task.id, 'merge could not be completed — manual review needed');
    return;
  }
  await logEvent(
    task.id,
    `merge conflict — resolving with the ${config.AGENT_EXECUTOR === 'hermes' ? 'hermes agent' : 'LLM'}`,
  );
  if (config.AGENT_EXECUTOR === 'hermes') {
    await resolveMergeConflictsViaHermes(task, rt, headBranch, workdir, cloneUrl, secrets, auth);
  } else {
    await resolveMergeConflictsOnce(task, rt, headBranch, workdir, cloneUrl, secrets, auth);
  }
  await persistTokenUsage(task.id, rt.usedTokens);
  await logEvent(task.id, 'pushed conflict resolution; waiting for CI before the next merge attempt');
  await enqueueMergeGate(task.id, attempt + 1, ciFixes, MERGE_GATE_DELAY_MS);
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export type MergeGateAction = 'merge' | 'wait' | 'fix-ci' | 'manual';

// Pure gate decision, unit-tested in tests/merge-gate.test.ts. Unsupported
// providers merge unverified; pending waits (bounded); failing triggers a
// hermes CI fix (bounded, hermes executor only); anything else is manual.
export function mergeGateAction(
  checks: PrChecksStatus,
  attempt: number,
  ciFixes: number,
  executor: string,
): MergeGateAction {
  if (!checks.supported || checks.state === 'green') return 'merge';
  if (checks.state === 'pending') return attempt >= MERGE_GATE_MAX_ATTEMPTS ? 'manual' : 'wait';
  if (ciFixes >= MAX_CI_FIX_ATTEMPTS || executor !== 'hermes') return 'manual';
  return 'fix-ci';
}

export async function mergeGateTask(taskId: string, attempt = 0, ciFixes = 0): Promise<void> {
  const task = await loadTaskWithRepo(taskId);
  if (!task) {
    console.error(`merge-gate: task ${taskId} not found`);
    return;
  }
  // Only merge PRs still waiting on an auto-merge repository. Merged/closed
  // tasks (pr-state-sync) and manual-merge repositories stop here.
  if (task.status !== 'awaiting_review' || !task.repository.autoMergePr || !task.branchName) {
    return;
  }
  const headBranch = task.branchName;
  const secrets: string[] = [];
  const workdir = path.join(config.AGENT_WORKDIR, `merge-gate-${taskId}-${attempt}-${ciFixes}`);
  let rt: LlmRuntime | null = null;
  try {
    const checks = await pullRequestChecksStatus(task.repository.connection, {
      repoFullName: task.repository.fullName,
      headBranch,
      baseBranch: task.repository.defaultBranch,
    });
    const action = mergeGateAction(checks, attempt, ciFixes, config.AGENT_EXECUTOR);
    if (action === 'wait') {
      await logEvent(task.id, `CI checks are running — re-checking in ${MERGE_GATE_DELAY_MS / 1000}s`);
      await enqueueMergeGate(taskId, attempt + 1, ciFixes, MERGE_GATE_DELAY_MS);
      return;
    }
    if (action === 'manual') {
      await logEvent(
        task.id,
        checks.state === 'pending'
          ? 'CI checks still running after ~30 minutes — awaiting manual merge'
          : ciFixes >= MAX_CI_FIX_ATTEMPTS
            ? `CI still failing after ${MAX_CI_FIX_ATTEMPTS} fix attempt(s) — awaiting manual fix`
            : 'CI checks are failing — awaiting manual fix',
      );
      return;
    }
    if (!checks.supported) {
      await logEvent(task.id, 'provider check statuses unavailable; merging on the review verdict alone');
    }
    const prepared = await prepareAgentRuntime(task, task.repository, secrets, task.llmTokensUsed);
    rt = prepared.rt;
    if (action === 'fix-ci') {
      await logEvent(
        task.id,
        `CI checks are failing — fixing with the hermes agent (attempt ${ciFixes + 1}/${MAX_CI_FIX_ATTEMPTS})`,
      );
      await runCiFixViaHermes(task, rt, headBranch, workdir, prepared.cloneUrl, secrets, prepared.gitAuth);
      await persistTokenUsage(task.id, rt.usedTokens);
      await enqueueMergeGate(taskId, attempt + 1, ciFixes + 1, MERGE_GATE_DELAY_MS);
      return;
    }
    await mergeWithConflictResolution(
      task,
      rt,
      headBranch,
      attempt,
      ciFixes,
      workdir,
      prepared.cloneUrl,
      secrets,
      prepared.gitAuth,
    );
  } catch (err) {
    // Rethrow so BullMQ retries with backoff; after the final attempt the
    // task stays awaiting_review for pr-state-sync's bounded recovery.
    await recordJobFailure('merge-gate', taskId, err, secrets);
    throw err;
  } finally {
    await persistTokenUsage(taskId, rt?.usedTokens ?? task.llmTokensUsed);
    await cleanupWorkdir(workdir);
  }
}
