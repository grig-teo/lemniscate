import type { FastifyReply, FastifyRequest } from 'fastify';

import { enqueueMergeGate, enqueueReviewTask } from '../lib/proposal-scheduler.js';
import { setTaskStatus } from '../lib/task-events.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { mergeBlocker, ownedTaskWhere, reviewBlocker } from './task-lifecycle.js';
import { idParamsSchema } from './task-schemas.js';

// Manual review- and merge-trigger handlers: POST /tasks/:id/review and
// POST /tasks/:id/merge. These let the PR pane manually start an LLM review
// or LLM-mediated merge on an awaiting_review task, bypassing the autoReviewPr
// / autoMergePr flags (which only gate the automatic post-run pipeline).

// Manually trigger an LLM code review on an awaiting_review task. Sets the
// status to reviewing_code and enqueues a review-pr job. The job itself is
// idempotent on re-trigger: BullMQ dedupes by jobId for the same attempt.
export async function triggerReview(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: { id: true, status: true, branchName: true },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }
  const blocker = reviewBlocker(task);
  if (blocker) {
    return reply.code(400).send({ error: blocker });
  }
  // Flip to reviewing_code so the PR pane shows the active status before the
  // worker picks up the job (the review-pr job also sets this, but the UI
  // update must not wait for the queue dispatch).
  await setTaskStatus(task.id, 'reviewing_code');
  await enqueueReviewTask(task.id, 0);
  return reply.code(202).send({ enqueued: true });
}

// Manually trigger an LLM-mediated merge on an awaiting_review (or
// reviewing_code) task. Enqueues a merge-gate job that runs CI checks,
// resolves conflicts, and merges the PR.
export async function triggerMerge(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: { id: true, status: true, branchName: true },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }
  const blocker = mergeBlocker(task);
  if (blocker) {
    return reply.code(400).send({ error: blocker });
  }
  await enqueueMergeGate(task.id, 0, 0);
  return reply.code(202).send({ enqueued: true });
}
