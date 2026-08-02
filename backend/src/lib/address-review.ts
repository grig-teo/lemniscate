import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';
import {
  checkoutTaskBranch,
  cleanupWorkdir,
  git,
  logEvent,
  persistTokenUsage,
  recordJobFailure,
  type GitAuth,
} from './agent-git.js';
import { applyReviewFixes } from './agent-review.js';
import {
  loadTaskWithRepo,
  prepareAgentRuntime,
  tokenSplit,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { reviewFromHumanComment } from './pr-review.js';
import { reviewFeedbackSkipReason, type ReviewFeedbackComment } from './review-feedback.js';
import { setTaskStatus } from './task-events.js';
import { prisma } from './prisma.js';
import { notify } from './notifications.js';

// Job: address-review — a human PR review comment the agent answers with a
// follow-up commit on the same branch. Enqueued by the webhook receiver
// (pr_review_comment) and the pr-state-sync poll fallback, gated per repo by
// autoAddressReview (default off). The fix itself is the review loop's own
// machinery (applyReviewFixes → buildAgentFixPrompt), so the agent treats
// human feedback exactly like its own review's change requests.

// The kept run workdir (<AGENT_WORKDIR>/<taskId>) survives while the task
// awaits review — address-review reuses it so a follow-up fix does not pay
// for a fresh clone. When it is gone (swept, or the task ran before keeping
// existed), checkoutTaskBranch re-clones; the cloneUrl was already vetted by
// prepareAgentRuntime's assertSafeCloneUrl gate.
async function prepareWorkdir(
  task: TaskWithRepo,
  workdir: string,
  cloneUrl: string,
  headBranch: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  const kept = await fs.stat(path.join(workdir, '.git')).then(
    () => true,
    () => false,
  );
  if (!kept) {
    await checkoutTaskBranch(workdir, cloneUrl, task.repository.defaultBranch, headBranch, secrets, auth);
    return;
  }
  // Reset the kept checkout to the remote branch tip: a previous fix or a
  // human push may have moved it, and stale leftovers must not ride along.
  await git(['fetch', '--depth', '1', 'origin', headBranch], { cwd: workdir, secrets, auth });
  await git(['checkout', '-B', headBranch, 'FETCH_HEAD'], { cwd: workdir });
  await git(['clean', '-fd'], { cwd: workdir });
}

async function markAddressed(taskId: string, comment: ReviewFeedbackComment): Promise<void> {
  await prisma.task
    .update({ where: { id: taskId }, data: { lastAddressedReviewId: comment.id } })
    .catch((err: unknown) => {
      logger.warn({ taskId, err }, 'address-review: failed to persist lastAddressedReviewId');
    });
}

async function executeAddressReview(
  task: TaskWithRepo,
  comment: ReviewFeedbackComment,
  workdir: string,
  secrets: string[],
): Promise<LlmRuntime> {
  const headBranch = task.branchName as string;
  await logEvent(
    task.id,
    `addressing review comment ${comment.id} from @${comment.author}` +
      (comment.path ? ` on ${comment.path}` : ''),
  );
  const { cloneUrl, gitAuth, rt } = await prepareAgentRuntime(
    task,
    task.repository,
    secrets,
    task.llmTokensUsed,
    task.repository.reviewLlmConfigId,
  );
  await prepareWorkdir(task, workdir, cloneUrl, headBranch, secrets, gitAuth);
  const review = reviewFromHumanComment(comment);
  await applyReviewFixes(task, rt, review, headBranch, workdir, cloneUrl, secrets, gitAuth);
  await markAddressed(task.id, comment);
  // A follow-up commit was just pushed — CI re-runs on the git host. Mirror
  // the review tail (review-finish.ts): the task waits for CI checks until a
  // ci_status webhook (or the merge-gate re-check) flips it back to
  // awaiting_review.
  await setTaskStatus(task.id, 'waiting_ci');
  await logEvent(task.id, `addressed review comment ${comment.id}`);
  await notify(task.repository.connection.userId, 'review_addressed', {
    title: `Review feedback addressed: ${task.title}`,
    body: `${task.repository.fullName} — pushed a follow-up commit for @${comment.author}'s comment`,
    taskId: task.id,
    ...(task.prUrl ? { prUrl: task.prUrl } : {}),
  });
  return rt;
}

export async function addressReviewTask(
  taskId: string,
  comment: ReviewFeedbackComment,
): Promise<void> {
  const task = await loadTaskWithRepo(taskId);
  if (!task) {
    logger.error({ taskId }, 'address-review: task not found');
    return;
  }
  // Re-check every gate at execution time: the flag may have been flipped
  // off (or the comment already addressed) between enqueue and run.
  const skip = reviewFeedbackSkipReason({
    taskStatus: task.status,
    branchName: task.branchName,
    lastAddressedReviewId: task.lastAddressedReviewId,
    autoAddressReview: task.repository.autoAddressReview,
    connectionUsername: task.repository.connection.username,
    comment,
  });
  if (skip) {
    logger.info({ taskId, reviewId: comment.id, skip }, 'address-review: skipped');
    return;
  }

  const secrets: string[] = [];
  const workdir = path.join(config.AGENT_WORKDIR, taskId);
  let rt: LlmRuntime | null = null;
  try {
    rt = await executeAddressReview(task, comment, workdir, secrets);
  } catch (err) {
    // Same contract as review-pr: record the failure, rethrow so BullMQ
    // retries with backoff. The marker is only written on success, so a
    // retried (or later re-polled) comment is attempted again.
    await recordJobFailure('address-review', taskId, err, secrets);
    throw err;
  } finally {
    await persistTokenUsage(
      taskId,
      rt?.usedTokens ?? task.llmTokensUsed,
      rt ? tokenSplit(rt) : undefined,
    );
    // The workdir stays while the task still awaits review (it is the kept
    // run workdir — merge/cleanup owns its removal); a task that meanwhile
    // reached a terminal state gets it cleaned up here.
    const status = (await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } }))
      ?.status;
    if (status !== 'awaiting_review' && status !== 'reviewing_code' && status !== 'waiting_ci') {
      await cleanupWorkdir(workdir, taskId);
    }
  }
}
