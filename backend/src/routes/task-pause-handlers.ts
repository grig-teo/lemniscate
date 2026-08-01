import type { FastifyReply, FastifyRequest } from 'fastify';
import { enqueueRunTask } from '../lib/proposal-scheduler.js';
import { prisma } from '../lib/prisma.js';
import { publishTaskEvent } from '../lib/task-events.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { buildResumeUpdate, ownedTaskWhere, pauseBlocker, resumeBlocker } from './task-lifecycle.js';
import { idParamsSchema } from './task-schemas.js';

// Task pause/resume handlers: put a running task on hold and resume it.
// Pause flips the status to 'paused' (detected by the executor loop, which
// exits cleanly without failing); resume re-queues and re-enqueues the run,
// which replays the saved transcript. Ownership-scoped like every action.

// Pause a running task: flips it to 'paused' so the executor loop notices on
// its next turn boundary / cancel-poll tick and stops without failing.
export async function pauseTask(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: { id: true, status: true },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }
  const blocker = pauseBlocker(task);
  if (blocker) {
    return reply.code(400).send({ error: blocker });
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { status: 'paused' },
  });
  await publishTaskEvent(task.id, 'status', { status: 'paused' });
  return { task: updated };
}

// Resume a paused task: re-queue and re-enqueue. Enqueued before the status
// flip (same anti-stranding rule as start/rerun); the resume update keeps the
// branch/PR intact so the run continues from the saved workdir, not from scratch.
export async function resumeTask(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: { id: true, status: true },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }
  const blocker = resumeBlocker(task);
  if (blocker) {
    return reply.code(400).send({ error: blocker });
  }

  await enqueueRunTask(task.id);
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: buildResumeUpdate(),
  });
  return { task: updated };
}
