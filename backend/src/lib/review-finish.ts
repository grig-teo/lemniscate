import type { Task } from '@prisma/client';
import { logEvent, persistTokenUsage } from './agent-git.js';
import { tokenSplit, type LlmRuntime, type TaskWithRepo } from './agent-runtime.js';
import { enqueueMergeGate, enqueueReviewTask } from './proposal-scheduler.js';
import type { PrReview } from './pr-review.js';
import { setTaskStatus } from './task-events.js';

// Shared review tail for every executor (internal / hermes / lemcore).
// AGENTS.md §6: one home — lemcore used to log "queued re-review" without
// actually enqueueing, which stranded tasks in reviewing_code forever.

export const MAX_REVIEW_FIX_ATTEMPTS = 3;

/** After the last fix attempt (or on approve): back to awaiting_review + optional merge gate. */
export async function finishReview(
  task: TaskWithRepo | (Task & { repository: { autoMergePr: boolean } }),
  review: PrReview,
): Promise<void> {
  await setTaskStatus(task.id, 'awaiting_review');
  if (review.verdict === 'changes_requested') {
    await logEvent(
      task.id,
      `review fix limit reached (${MAX_REVIEW_FIX_ATTEMPTS}); continuing with the latest state`,
    );
  }
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
 * While the reviewer keeps requesting changes and the attempt cap allows it,
 * run one fix iteration and queue a re-review; otherwise hand the PR to the
 * merge gate / manual review.
 */
export async function continueOrFinishReview(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  attempt: number,
  runFixIteration: () => Promise<void>,
): Promise<void> {
  if (review.verdict === 'changes_requested' && attempt < MAX_REVIEW_FIX_ATTEMPTS) {
    await runFixIteration();
    await persistTokenUsage(task.id, rt.usedTokens, tokenSplit(rt));
    await enqueueReviewTask(task.id, attempt + 1);
    await logEvent(task.id, 'queued re-review of the updated pull request');
    return;
  }
  await finishReview(task, review);
}
