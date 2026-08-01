import type { FastifyReply, FastifyRequest } from 'fastify';

import { publishTaskEvent } from '../lib/task-events.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { backlogBlocker, ownedTaskWhere } from './task-lifecycle.js';
import { idParamsSchema } from './task-schemas.js';

// Return an in-flight task to the backlog (pending) — the Kanban drag-back to
// "Prompts / Proposals". Extracted from task-action-handlers.ts so that file
// stays under the 300-line module limit (AGENTS.md §2). Only non-terminal
// in-flight states are eligible (backlogBlocker); the worker self-guards
// against a now-stale queued job (it no-ops on non-queued tasks), so no
// explicit BullMQ removal is needed.
export async function returnToBacklog(request: FastifyRequest, reply: FastifyReply) {
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
  const blocker = backlogBlocker(task);
  if (blocker) {
    return reply.code(400).send({ error: blocker });
  }
  if (task.status === 'pending') {
    return { task: await prisma.task.findUniqueOrThrow({ where: { id: task.id } }) };
  }
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { status: 'pending', error: null, errorCode: null },
  });
  await publishTaskEvent(task.id, 'status', { status: 'pending' });
  return { task: updated };
}
