import { logEvent } from './agent-git.js';
import { prisma } from './prisma.js';
import { enqueueReviewTask } from './proposal-scheduler.js';
import { rateLimitDeferMs } from './llm-rate-limit.js';
import { setTaskStatus } from './task-events.js';

// Rate-limit deferral for the review-pr job (split out of agent-review.ts —
// AGENTS.md §2 file-size limit). When a review fails because the LLM
// provider is out of quota (HTTP 429, reset windows that can span hours),
// retrying on BullMQ's 60s backoff just burns attempts and used to strand
// the PR in awaiting_review forever once the bounded pr-state-sync recovery
// budget ran out. Instead the job records the failure, parks the task, and
// re-enqueues itself past the provider's reset window.

// Bounded so a permanently quota-dead config eventually surfaces as a plain
// failure instead of deferring forever.
const MAX_RATE_LIMIT_DEFERS = 12;
const RATE_LIMIT_DEFER_LOG = 'review paused: LLM rate limit reached';

async function countRateLimitDefers(taskId: string): Promise<number> {
  return prisma.taskEvent.count({
    where: {
      taskId,
      kind: 'log',
      payload: { path: ['line'], string_starts_with: RATE_LIMIT_DEFER_LOG },
    },
  });
}

// Handles a review-job failure caused by an LLM rate limit: while the defer
// budget lasts, parks the task back in awaiting_review, logs a user-visible
// pause line — the LAST log line, so pr-state-sync's stuck detector (which
// looks for a trailing 'error:' line) leaves the deferred job alone — and
// re-enqueues the review after the provider's reset window. Returns true
// when the failure was deferred; false for non-rate-limit errors and once
// the budget is exhausted (the caller rethrows for normal BullMQ retry).
export async function deferRateLimitedReview(taskId: string, err: unknown): Promise<boolean> {
  const deferMs = rateLimitDeferMs(err);
  if (deferMs === null) return false;
  const defers = await countRateLimitDefers(taskId);
  if (defers >= MAX_RATE_LIMIT_DEFERS) return false;
  await setTaskStatus(taskId, 'awaiting_review');
  const resumeAt = new Date(Date.now() + deferMs);
  await logEvent(taskId, `${RATE_LIMIT_DEFER_LOG} — retrying at ${resumeAt.toISOString()}`);
  await enqueueReviewTask(taskId, 0, deferMs, defers + 1);
  return true;
}
