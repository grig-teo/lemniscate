import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { isArchivable, ownedTaskWhere } from './task-lifecycle.js';
import { idParamsSchema } from './task-schemas.js';

// Task archive handlers: hide/show tasks in the task lists. Ownership-scoped
// via ownedTaskWhere like every other task action handler.

// Archive a task: hide it from the task lists. Running and queued tasks
// cannot be archived — cancel them first.
export async function archiveTask(request: FastifyRequest, reply: FastifyReply) {
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
  if (!isArchivable(task.status)) {
    return reply.code(409).send({ error: `Task is ${task.status} and cannot be archived` });
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { archivedAt: new Date() },
  });
  return { task: updated };
}

// Unarchive a task: clear archivedAt so it reappears in the task lists.
export async function unarchiveTask(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: { id: true },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { archivedAt: null },
  });
  return { task: updated };
}
