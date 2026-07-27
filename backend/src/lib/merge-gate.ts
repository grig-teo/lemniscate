import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';
import {
  checkoutTaskBranch,
  cleanupWorkdir,
  commitAndPush,
  hasDirtyWorkdir,
  logEvent,
  persistTokenUsage,
  recordJobFailure,
} from './agent-git.js';
import {
  loadTaskWithRepo,
  prepareAgentRuntime,
  tokenSplit,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { runHermesTask } from './hermes-runner.js';
import type { GateContext } from './merge-gate-context.js';
import {
  hermesLlm,
  prepareMergeCheckout,
  rebaseHeadBranchViaHermes,
  rebaseHeadBranchWithLlm,
} from './merge-gate-rebase.js';
import { notify, notifyOncePerTask } from './notifications.js';
import { enqueueMergeGate } from './proposal-scheduler.js';
import { queueDeployment } from './deploy/deploy-service.js';
import { prisma } from './prisma.js';
import { mergePullRequest, pullRequestChecksStatus, type PrChecksStatus } from './pull-requests.js';
import { buildHermesCiFixPrompt } from './pr-review.js';
import { setTaskStatus } from './task-events.js';
import { errorMessage } from './utils.js';

// Job: merge-gate — owns the PR after the review passes on an auto-merge
// repository. The PR merges ONLY when provider CI checks are green:
//   pending  → re-enqueue with a delay and check again (bounded, ~30 min)
//   failing  → the hermes agent fixes the branch first, then re-check
//   stale    → main moved since the branch started: rebase the task branch
//              onto main (conflicts resolved by hermes or direct LLM),
//              force-push, and wait for CI on the rebased head before the
//              next merge attempt — never main-into-branch merge commits
// Providers without a checks API (e.g. GitVerse) merge unverified, as before.

export const MERGE_GATE_DELAY_MS = 60_000;
// ~30 minutes of pending CI at the 60s re-check cadence.
export const MERGE_GATE_MAX_ATTEMPTS = 30;
export const MAX_CI_FIX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// CI fix (hermes)
// ---------------------------------------------------------------------------

async function runCiFixViaHermes(ctx: GateContext): Promise<void> {
  const { task, rt, headBranch, workdir, cloneUrl, secrets, auth } = ctx;
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

// Auto-deploy: a merged PR redeploys the repository's service when it has
// one with autoDeploy on. Failures here must never block the merge result.
async function maybeQueueServiceDeploy(task: TaskWithRepo): Promise<void> {
  try {
    const service = await prisma.service.findUnique({
      where: { repositoryId: task.repositoryId },
    });
    if (!service?.autoDeploy) return;
    await queueDeployment(service.id, task.id);
    await logEvent(task.id, `queued deploy of service '${service.name}'`);
  } catch (err) {
    await logEvent(task.id, `could not queue the service deploy: ${errorMessage(err)}`).catch(
      () => {},
    );
  }
}

// One merge attempt. Rebase-first: when main advanced since the branch
// started, the task branch is rebased onto it (conflicts resolved by the
// agent) and force-pushed, then the gate re-enqueues — CI must pass on the
// rebased head before the next merge attempt (this is how a broken rebase
// never reaches main). A direct provider merge happens only when the branch
// is already up to date with main.
async function mergeWithConflictResolution(ctx: GateContext): Promise<void> {
  const { task, rt, headBranch, attempt, ciFixes } = ctx;
  const stale = await prepareMergeCheckout(ctx);
  if (!stale) {
    const result = await mergePullRequest(task.repository.connection, {
      repoFullName: task.repository.fullName,
      headBranch,
      baseBranch: task.repository.defaultBranch,
    });
    if (result.merged) {
      await logEvent(task.id, `merged pull request: ${result.prUrl}`);
      await setTaskStatus(task.id, 'done');
      await notify(task.repository.connection.userId, 'pr_merged', {
        title: `PR merged: ${task.title}`,
        body: `${task.repository.fullName} — pull request auto-merged by the merge gate`,
        taskId: task.id,
        prUrl: result.prUrl,
      });
      // The task's run workdir was kept for the review window — merged means
      // it is no longer needed.
      await cleanupWorkdir(path.join(config.AGENT_WORKDIR, task.id), task.id);
      await maybeQueueServiceDeploy(task);
      return;
    }
    if (!result.conflict) {
      await stopForManualMerge(task);
      return;
    }
    // Conflict despite an up-to-date branch: main moved between the
    // staleness check and the provider call — fall through to the rebase.
  }
  if (attempt >= MERGE_GATE_MAX_ATTEMPTS) {
    await stopForManualMerge(task);
    return;
  }
  await logEvent(
    task.id,
    stale
      ? 'main moved since the branch started — rebasing the task branch onto it'
      : 'merge conflict — rebasing the task branch onto main',
  );
  if (config.AGENT_EXECUTOR === 'hermes') {
    await rebaseHeadBranchViaHermes(ctx);
  } else {
    await rebaseHeadBranchWithLlm(ctx);
  }
  await persistTokenUsage(task.id, rt.usedTokens, tokenSplit(rt));
  await logEvent(task.id, 'pushed the rebased branch; waiting for CI before the next merge attempt');
  await enqueueMergeGate(task.id, attempt + 1, ciFixes, MERGE_GATE_DELAY_MS);
}

// The gate cannot (or may no longer) merge: log + one notification per task.
async function stopForManualMerge(task: TaskWithRepo): Promise<void> {
  await logEvent(task.id, 'merge could not be completed — manual review needed');
  await notifyOncePerTask(task.repository.connection.userId, 'merge_gate_failed', {
    title: `Merge gate gave up: ${task.title}`,
    body: `${task.repository.fullName} — merge could not be completed; manual review needed`,
    taskId: task.id,
    prUrl: task.prUrl ?? undefined,
  });
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

// Why the gate stops at manual, for the task log.
function manualGateMessage(checks: PrChecksStatus, ciFixes: number): string {
  if (checks.state === 'pending') {
    return 'CI checks still running after ~30 minutes — awaiting manual merge';
  }
  if (ciFixes >= MAX_CI_FIX_ATTEMPTS) {
    return `CI still failing after ${MAX_CI_FIX_ATTEMPTS} fix attempt(s) — awaiting manual fix`;
  }
  return 'CI checks are failing — awaiting manual fix';
}

// fix-ci: hermes fixes the branch, then the gate re-enqueues — CI must pass
// on the fix commit before the next merge attempt.
async function runCiFixAndRequeue(ctx: GateContext): Promise<void> {
  const { task, rt } = ctx;
  await logEvent(
    task.id,
    `CI checks are failing — fixing with the hermes agent (attempt ${ctx.ciFixes + 1}/${MAX_CI_FIX_ATTEMPTS})`,
  );
  await runCiFixViaHermes(ctx);
  await persistTokenUsage(task.id, rt.usedTokens, tokenSplit(rt));
  await enqueueMergeGate(task.id, ctx.attempt + 1, ctx.ciFixes + 1, MERGE_GATE_DELAY_MS);
}

// Dispatches the decided action. Returns false when the gate is done for
// this job (wait/manual) and no runtime needs preparing. The manual stop
// also notifies the user once per task — the gate can re-evaluate it on
// every recovery re-enqueue, and the unread dedupe keeps that from spamming.
async function dispatchGateAction(
  action: MergeGateAction,
  checks: PrChecksStatus,
  task: TaskWithRepo,
  attempt: number,
  ciFixes: number,
): Promise<boolean> {
  if (action === 'wait') {
    await logEvent(task.id, `CI checks are running — re-checking in ${MERGE_GATE_DELAY_MS / 1000}s`);
    await enqueueMergeGate(task.id, attempt + 1, ciFixes, MERGE_GATE_DELAY_MS);
    return false;
  }
  if (action === 'manual') {
    const reason = manualGateMessage(checks, ciFixes);
    await logEvent(task.id, reason);
    await notifyOncePerTask(task.repository.connection.userId, 'merge_gate_failed', {
      title: `Merge gate gave up: ${task.title}`,
      body: `${task.repository.fullName} — ${reason}`,
      taskId: task.id,
      prUrl: task.prUrl ?? undefined,
    });
    return false;
  }
  return true;
}

export async function mergeGateTask(taskId: string, attempt = 0, ciFixes = 0): Promise<void> {
  const task = await loadTaskWithRepo(taskId);
  if (!task) {
    logger.error({ taskId }, 'merge-gate: task not found');
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
    if (!(await dispatchGateAction(action, checks, task, attempt, ciFixes))) return;
    if (!checks.supported) {
      await logEvent(task.id, 'provider check statuses unavailable; merging on the review verdict alone');
    }
    const prepared = await prepareAgentRuntime(task, task.repository, secrets, task.llmTokensUsed);
    rt = prepared.rt;
    const ctx: GateContext = {
      task, rt, headBranch, attempt, ciFixes, workdir,
      cloneUrl: prepared.cloneUrl, secrets, auth: prepared.gitAuth,
    };
    if (action === 'fix-ci') {
      await runCiFixAndRequeue(ctx);
      return;
    }
    await mergeWithConflictResolution(ctx);
  } catch (err) {
    // Rethrow so BullMQ retries with backoff; after the final attempt the
    // task stays awaiting_review for pr-state-sync's bounded recovery.
    await recordJobFailure('merge-gate', taskId, err, secrets);
    throw err;
  } finally {
    await persistTokenUsage(
      taskId,
      rt?.usedTokens ?? task.llmTokensUsed,
      rt ? tokenSplit(rt) : undefined,
    );
    await cleanupWorkdir(workdir);
  }
}
