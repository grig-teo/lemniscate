import path from 'node:path';
import { hasMeaningfulChanges } from './workdir-changes.js';
import { config } from '../config.js';
import { logger } from './logger.js';
import {
  checkoutTaskBranch,
  cleanupWorkdir,
  commitAndPush,
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
import { resolveAgentExecutor } from './agent-executor.js';
import { runHermesTask } from './hermes-runner.js';
import { runLemcoreTask } from './lemcore/run.js';
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
import { buildAgentCiFixPrompt } from './pr-review.js';
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
// Forced rebase + fresh fix-budget rounds granted after the CI-fix budget is
// spent — the agent (never a human) gets one more shot on rebased code.
export const MAX_REBASE_RETRIES = 1;

// ---------------------------------------------------------------------------
// CI fix (hermes or lemcore)
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
  const ciPrompt = buildAgentCiFixPrompt({
    taskTitle: task.title,
    baseBranch: task.repository.defaultBranch,
    headBranch,
    systemPromptExtra: rt.cfg.systemPromptExtra,
    failingChecks: ctx.failingChecks,
  });
  const executor = await resolveAgentExecutor(task.repository.connection.userId);
  if (executor === 'lemcore') {
    await runLemcoreTask({
      taskId: task.id,
      task,
      workdir,
      rt,
      secrets,
      resume: false,
      promptOverride: ciPrompt,
    });
  } else {
    await runHermesTask({
      workdir,
      prompt: ciPrompt,
      llm: hermesLlm(rt),
      taskId: task.id,
      secrets,
      timeoutMs: config.AGENT_HERMES_TIMEOUT_MINUTES * 60_000,
      stallTimeoutMs: config.AGENT_HERMES_STALL_TIMEOUT_MINUTES * 60_000,
    });
  }
  if (!(await hasMeaningfulChanges(workdir))) {
    await logEvent(task.id, 'agent produced no CI fix changes');
    return;
  }
  const lemcore = executor === 'lemcore';
  await commitAndPush(
    task,
    rt,
    workdir,
    lemcore ? 'fix failing CI checks (lemcore)' : 'fix failing CI checks',
    ['push', 'origin', headBranch],
    secrets,
    auth,
  );
  await logEvent(
    task.id,
    lemcore ? `pushed CI fixes to ${headBranch} (lemcore)` : `pushed CI fixes to ${headBranch}`,
  );
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
  await rebaseHeadBranchForExecutor(ctx);
  await persistTokenUsage(task.id, rt.usedTokens, tokenSplit(rt));
  await logEvent(task.id, 'pushed the rebased branch; waiting for CI before the next merge attempt');
  await enqueueMergeGate(task.id, attempt + 1, ciFixes, MERGE_GATE_DELAY_MS, ctx.rebaseRetries);
}

// Executor dispatch for the rebase-and-resolve-conflicts step, shared by the
// merge path and the rebase-retry fallback.
async function rebaseHeadBranchForExecutor(ctx: GateContext): Promise<void> {
  const executor = await resolveAgentExecutor(ctx.task.repository.connection.userId);
  if (executor === 'hermes') {
    await rebaseHeadBranchViaHermes(ctx);
  } else if (executor === 'lemcore') {
    const { rebaseHeadBranchViaLemcore } = await import('./merge-gate-rebase.js');
    await rebaseHeadBranchViaLemcore(ctx);
  } else {
    await rebaseHeadBranchWithLlm(ctx);
  }
}

// rebase-retry: the CI-fix budget is spent. Red CI after several fix rounds
// is usually main-drift the branch-local patches can't cure, so force a
// rebase onto main (stale or not) and hand the fix agent a FRESH budget on
// the rebased branch — the agent resolves it, not a human. Bounded once.
async function runRebaseRetryAndRequeue(ctx: GateContext): Promise<void> {
  const { task, rt } = ctx;
  await logEvent(
    task.id,
    `CI fixes exhausted (${MAX_CI_FIX_ATTEMPTS}) — rebasing onto main and retrying with a fresh fix budget`,
  );
  await prepareMergeCheckout(ctx);
  await rebaseHeadBranchForExecutor(ctx);
  await persistTokenUsage(task.id, rt.usedTokens, tokenSplit(rt));
  await logEvent(task.id, 'pushed the rebased branch; waiting for CI before the fresh fix round');
  await setTaskStatus(task.id, 'waiting_ci');
  await enqueueMergeGate(task.id, ctx.attempt + 1, 0, MERGE_GATE_DELAY_MS, ctx.rebaseRetries + 1);
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

export type MergeGateAction = 'merge' | 'wait' | 'fix-ci' | 'rebase-retry' | 'manual';

// Pure gate decision, unit-tested in tests/merge-gate.test.ts. Unsupported
// providers merge unverified; pending waits (bounded); failing triggers an
// agent CI fix (bounded); when the fix budget is spent, ONE forced rebase
// onto main with a fresh fix budget (stale-branch drift is the usual reason
// fixes produce nothing); only then manual.
export function mergeGateAction(
  checks: PrChecksStatus,
  attempt: number,
  ciFixes: number,
  executor: string,
  rebaseRetries = 0,
): MergeGateAction {
  if (!checks.supported || checks.state === 'green') return 'merge';
  if (checks.state === 'pending') return attempt >= MERGE_GATE_MAX_ATTEMPTS ? 'manual' : 'wait';
  if (executor !== 'hermes' && executor !== 'lemcore') return 'manual';
  if (ciFixes >= MAX_CI_FIX_ATTEMPTS) {
    return rebaseRetries >= MAX_REBASE_RETRIES ? 'manual' : 'rebase-retry';
  }
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
// on the fix commit before the next merge attempt. Rebase-first: when main
// moved, red CI is often unfixable by a branch-local patch (broken workflow
// files, guard regressions already fixed on main, divergent test setup) —
// hermes fixes are only worth their tokens on an up-to-date branch.
async function runCiFixAndRequeue(ctx: GateContext): Promise<void> {
  const { task, rt } = ctx;
  if (await prepareMergeCheckout(ctx)) {
    await logEvent(
      task.id,
      'CI is failing and main moved — rebasing the task branch onto it before diagnosing further',
    );
    await rebaseHeadBranchForExecutor(ctx);
    await persistTokenUsage(task.id, rt.usedTokens, tokenSplit(rt));
    await logEvent(task.id, 'pushed the rebased branch; waiting for CI before the next merge attempt');
    await setTaskStatus(task.id, 'waiting_ci');
    await enqueueMergeGate(task.id, ctx.attempt + 1, ctx.ciFixes, MERGE_GATE_DELAY_MS, ctx.rebaseRetries);
    return;
  }
  await logEvent(
    task.id,
    `CI checks are failing — fixing with the hermes agent (attempt ${ctx.ciFixes + 1}/${MAX_CI_FIX_ATTEMPTS})`,
  );
  await runCiFixViaHermes(ctx);
  await persistTokenUsage(task.id, rt.usedTokens, tokenSplit(rt));
  // The CI fix was pushed — the task waits for checks on the fix commit.
  await setTaskStatus(task.id, 'waiting_ci');
  await enqueueMergeGate(task.id, ctx.attempt + 1, ctx.ciFixes + 1, MERGE_GATE_DELAY_MS, ctx.rebaseRetries);
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
  rebaseRetries: number,
): Promise<boolean> {
  if (action === 'wait') {
    // CI is running on the git host — show it. The next re-check (or the
    // ci_status webhook) flips the task back to awaiting_review.
    await setTaskStatus(task.id, 'waiting_ci');
    await logEvent(task.id, `CI checks are running — re-checking in ${MERGE_GATE_DELAY_MS / 1000}s`);
    await enqueueMergeGate(task.id, attempt + 1, ciFixes, MERGE_GATE_DELAY_MS, rebaseRetries);
    return false;
  }
  if (action === 'manual') {
    const reason = manualGateMessage(checks, ciFixes);
    // The gate stops here and nothing re-triggers it, so the task must NOT
    // stay in waiting_ci (nothing would flip it back). It is awaiting_review:
    // a human merging (or a ci_status webhook) still routes through the
    // awaiting pipeline, which review-pr guards by freshness anyway.
    await setTaskStatus(task.id, 'awaiting_review');
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

export async function mergeGateTask(
  taskId: string,
  attempt = 0,
  ciFixes = 0,
  rebaseRetries = 0,
): Promise<void> {
  const task = await loadTaskWithRepo(taskId);
  if (!task) {
    logger.error({ taskId }, 'merge-gate: task not found');
    return;
  }
  // Only merge PRs still waiting on an auto-merge repository. Merged/closed
  // tasks (pr-state-sync) and manual-merge repositories stop here. A
  // waiting_ci task re-checks too: it is the merge-gate's own wait/fix-ci
  // state, and this poll doubles as the flip-back to awaiting_review when
  // the ci_status webhook never arrives (GitVerse/Gitee have no webhooks).
  if (
    (task.status !== 'awaiting_review' && task.status !== 'waiting_ci') ||
    !task.repository.autoMergePr ||
    !task.branchName
  ) {
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
    // The merge gate only ever runs on pushed code — CI activity (or its
    // absence) is settled by the time the checks status reads green/failing/
    // pending. Flip a waiting_ci task back to awaiting_review first: the
    // re-enqueued review-pr pass then reviews the final code and hands the
    // PR back to this gate, so nothing merges unreviewed.
    if (task.status === 'waiting_ci') {
      await setTaskStatus(taskId, 'awaiting_review');
    }
    const executor = await resolveAgentExecutor(task.repository.connection.userId);
    const action = mergeGateAction(checks, attempt, ciFixes, executor, rebaseRetries);
    if (!(await dispatchGateAction(action, checks, task, attempt, ciFixes, rebaseRetries))) return;
    if (!checks.supported) {
      await logEvent(task.id, 'provider check statuses unavailable; merging on the review verdict alone');
    }
    const prepared = await prepareAgentRuntime(task, task.repository, secrets, task.llmTokensUsed);
    rt = prepared.rt;
    const ctx: GateContext = {
      task, rt, headBranch, attempt, ciFixes, rebaseRetries, workdir,
      cloneUrl: prepared.cloneUrl, secrets, auth: prepared.gitAuth,
      failingChecks: checks.failingChecks,
    };
    if (action === 'fix-ci') {
      await runCiFixAndRequeue(ctx);
      return;
    }
    if (action === 'rebase-retry') {
      await runRebaseRetryAndRequeue(ctx);
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
