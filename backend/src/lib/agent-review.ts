import path from 'node:path';
import fs from 'node:fs/promises';
import type { Task } from '@prisma/client';
import { config } from '../config.js';
import { logger } from './logger.js';
import {
  cleanupWorkdir,
  logEvent,
  persistTokenUsage,
  recordJobFailure,
  type GitAuth,
} from './agent-git.js';
import {
  loadTaskWithRepo,
  prepareAgentRuntime,
  tokenSplit,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { runLemcoreReview, runLemcoreFixIteration } from './lemcore/review.js';
import { deferRateLimitedReview } from './review-defer.js';
import { setTaskStatus } from './task-events.js';
import { getPullRequestDiff } from './pull-requests.js';
import { type PrReview } from './pr-review.js';
import { requestReviewWithRetry } from './review-request.js';
import { isTaskPaused, TaskPausedError } from './task-pause.js';
import { prisma } from './prisma.js';
import { transcriptPath } from './lemcore/loop-constants.js';

// Job: review-pr — review → fix iteration → hand-off to the merge gate.
// Lemcore is the only agent: it reviews in a checked-out clone of the task
// branch and fixes its own findings on that checkout. Merging lives in
// merge-gate.ts (CI-gated).

const MAX_REVIEW_DIFF_CHARS = 24_000;
// Full review loops per PR (re-enqueues from restarts/recovery included —
// counted via the 'reviewing pull request' log events, no schema counter
// needed). Each loop can run 60 turns; beyond the cap the PR goes back to
// the merge gate / manual review instead of burning more tokens.
export const MAX_REVIEW_LOOPS = 3;

// Direct structured review call — the fallback when lemcore leaves no valid
// review file. Empty/invalid replies (a z.ai GLM quirk) are retried with a
// nudge inside review-request.ts. When repoContext is provided the reviewer
// sees the file tree + key files + AGENTS.md alongside the diff, so verdicts
// can reference repo conventions and surrounding code.
export async function requestReview(
  rt: LlmRuntime,
  task: Task,
  diff: string,
  repoContext?: string | null,
): Promise<PrReview> {
  return requestReviewWithRetry(rt, task, diff, repoContext);
}

export async function fetchReviewDiff(task: TaskWithRepo, headBranch: string): Promise<string> {
  const { repository } = task;
  const rawDiff = await getPullRequestDiff(repository.connection, {
    repoFullName: repository.fullName,
    headBranch,
    baseBranch: repository.defaultBranch,
  });
  if (rawDiff.length <= MAX_REVIEW_DIFF_CHARS) return rawDiff;
  const truncated = rawDiff.slice(0, MAX_REVIEW_DIFF_CHARS);
  const totalFiles = (rawDiff.match(/^diff --git a\//gm) ?? []).length;
  const shownFiles = (truncated.match(/^diff --git a\//gm) ?? []).length;
  return `${truncated}\n… [truncated; ~${shownFiles} of ${totalFiles} files shown]`;
}

// The fix tail shared by the review loop and the address-review job
// (AGENTS.md §6 — single home): assumes the task branch is already checked
// out in `workdir`; the lemcore agent fixes the review issues on that
// checkout and pushes to the same branch.
export async function applyReviewFixes(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  headBranch: string,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  // cloneUrl is unused: the branch is already checked out in `workdir` — the
  // parameter stays so the review loop and address-review share one call shape.
  void cloneUrl;
  await runLemcoreFixIteration(task, rt, review, headBranch, workdir, secrets, auth);
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

// Auto-merge is delegated to the merge-gate job: it waits for green CI,
// sends the agent to fix failing checks, and resolves conflicts (again
// waiting for CI on the resolution). The review job ends here — flip the
// task back to awaiting_review so the landing page no longer shows it as
// "reviewing". finishReview / continueOrFinishReview live in
// review-finish.ts (single home for the review finish path).

// Returns the runtime so the caller can persist cumulative token usage.
async function executeReviewTask(
  task: TaskWithRepo,
  headBranch: string,
  attempt: number,
  workdir: string,
  secrets: string[],
): Promise<LlmRuntime> {
  // Signal that the agent is actively reviewing — this shows the task as
  // "reviewing code" on the landing page while the review job runs.
  await setTaskStatus(task.id, 'reviewing_code');
  // The repository's review LLM (when configured) wins over the task's
  // implementation config — review and fix iterations run on it.
  const { cloneUrl, gitAuth, rt } = await prepareAgentRuntime(
    task,
    task.repository,
    secrets,
    task.llmTokensUsed,
    task.repository.reviewLlmConfigId,
  );
  return runLemcoreReview(task, rt, headBranch, attempt, workdir, cloneUrl, secrets, gitAuth);
}

export async function reviewTask(taskId: string, attempt = 0): Promise<void> {
  const task = await loadTaskWithRepo(taskId);
  if (!task) {
    logger.error({ taskId }, 'review-pr: task not found');
    return;
  }
  // Only review PRs still waiting for review on an opted-in repository.
  // 'reviewing_code' is accepted so re-enqueued review iterations (fix
  // loop) and BullMQ retries don't bounce on the guard. 'waiting_ci' is
  // NOT accepted: its fixture carries the agent's own push, so an early
  // ci_status webhook / merge-gate re-check must flip the task back to
  // awaiting_review first, arming a fresh review pass on the final code.
  const inReview = task.status === 'awaiting_review' || task.status === 'reviewing_code';
  if (!inReview || !task.repository.autoReviewPr) {
    return;
  }
  if (!task.branchName) {
    await logEvent(taskId, 'cannot review: the task has no branch');
    return;
  }
  // Bound full review loops per PR; past the cap the PR goes back to the
  // merge gate instead of re-reviewing forever on every recovery re-enqueue.
  const priorReviews = await prisma.taskEvent.count({
    where: {
      taskId,
      kind: 'log',
      payload: { path: ['line'], string_contains: 'reviewing pull request' },
    },
  });
  if (priorReviews >= MAX_REVIEW_LOOPS) {
    await logEvent(taskId, `review loop cap reached (${MAX_REVIEW_LOOPS}) — handing the PR back to review/merge flow`);
    await setTaskStatus(taskId, 'awaiting_review');
    return;
  }

  const secrets: string[] = [];
  const workdir = path.join(config.AGENT_WORKDIR, `review-${taskId}-${attempt}`);
  let rt: LlmRuntime | null = null;
  try {
    rt = await executeReviewTask(task, task.branchName, attempt, workdir, secrets);
  } catch (err) {
    if (err instanceof TaskPausedError) {
      // Paused mid-review: status stays 'paused' (resume re-enqueues the
      // review) — do NOT record a failure or rethrow into a retry.
      await logEvent(taskId, 'paused by user — resume continues the review').catch(() => {});
      return;
    }
    // Record the failure. A rate-limited review defers itself past the
    // provider's quota window and completes the job instead of rethrowing —
    // BullMQ's 60s backoff is useless against a multi-hour 429 and the old
    // path stranded the PR after the bounded recovery budget ran out. Other
    // failures rethrow so BullMQ retries the job with backoff; if the final
    // attempt also fails the PR stays in reviewing_code until
    // pr-state-sync's bounded recovery re-enqueues it.
    await recordJobFailure('review-pr', taskId, err, secrets);
    if (await deferRateLimitedReview(taskId, err)) return;
    throw err;
  } finally {
    await persistTokenUsage(
      taskId,
      rt?.usedTokens ?? task.llmTokensUsed,
      rt ? tokenSplit(rt) : undefined,
    );
    // Paused reviews keep the workdir (and transcript) for the resume.
    const paused = await isTaskPaused(taskId);
    if (!paused) {
      await cleanupWorkdir(workdir, taskId);
      // The transcript lives beside the workdir — drop it too, or a later
      // review of NEW commits would resume a stale conversation.
      await fs.rm(transcriptPath(workdir), { force: true }).catch(() => undefined);
    }
  }
}
