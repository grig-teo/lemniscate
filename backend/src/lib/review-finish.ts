import type { Task } from '@prisma/client';
import { logEvent, persistTokenUsage } from './agent-git.js';
import { tokenSplit, type LlmRuntime, type TaskWithRepo } from './agent-runtime.js';
import { enqueueMergeGate } from './proposal-scheduler.js';
import type { PrReview } from './pr-review.js';
import { setTaskStatus } from './task-events.js';

// Shared review tail for every executor (internal / hermes / lemcore).
// AGENTS.md §6: one home — lemcore used to log "queued re-review" without
// actually enqueueing, which stranded tasks in reviewing_code forever.
//
// Contract: exactly ONE review pass per task. When the reviewer returns
// changes_requested, the reviewer's fixes are applied a SINGLE time and the
// review ends — there is no re-review loop (previously this re-reviewed up to
// 4 times per task).

/**
 * After the fix (or on approve): waiting_ci (checks run on the pushed code) +
 * optional merge gate. The agent just pushed the reviewed branch — CI is
 * (re)running on the git host, so the task waits for CI checks, not for
 * review. A ci_status webhook (or the next merge-gate re-check) flips it back
 * to awaiting_review, which re-runs review-pr on the final code before merge.
 */
export async function finishReview(
  task: TaskWithRepo | (Task & { repository: { autoMergePr: boolean } }),
  review: PrReview,
): Promise<void> {
  await setTaskStatus(task.id, 'waiting_ci');
  if (!task.repository.autoMergePr) {
    await logEvent(
      task.id,
      review.verdict === 'approve'
        ? 'approved by LLM, awaiting manual merge'
        : 'changes still requested, awaiting manual review',
    );
    return;
  }
  await logEvent(task.id, 'queued the merge gate — auto-merge once CI is green');
  await enqueueMergeGate(task.id, 0, 0);
}

/**
 * Single review pass. On changes_requested, apply the reviewer's fixes ONCE
 * (no re-review to confirm them), then finish — approve or not, the PR is
 * handed to the merge gate / manual review.
 */
export async function continueOrFinishReview(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  runFixIteration: () => Promise<void>,
): Promise<void> {
  if (review.verdict === 'changes_requested') {
    await runFixIteration();
    await persistTokenUsage(task.id, rt.usedTokens, tokenSplit(rt));
  }
  await finishReview(task, review);
}
