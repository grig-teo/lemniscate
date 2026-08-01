import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { ownedTaskWhere } from './task-lifecycle.js';
import { followsBodySchema, idParamsSchema } from './task-schemas.js';

// Handler for POST /tasks/:id/follows — the manual follow-up task link.
// Sets which task is auto-queued when this task reaches 'done' (the firing
// logic itself lives in lib/task-next.ts, invoked from setTaskStatus).
//
// Rules:
//   - The predecessor must be owned by the caller (ownedTaskWhere).
//   - The successor (nextTaskId) must exist and belong to the SAME repository
//     — a follow-up cannot cross repos (its auto-run resolves the repo's
//     connection/secrets, which only make sense within one repo).
//   - A predecessor cannot point at itself, and cannot already be the
//     successor of another task that is about to run it (acyclic intent is
//     the caller's responsibility, but direct self-reference is rejected).
//   - An explicit null clears the link (DELETE semantics via POST).

export async function setFollowsTask(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const body = parseOrReply(followsBodySchema, request.body, reply, 'Invalid request body', {
    includeIssues: true,
  });
  if (body === null) return;

  const predecessor = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: { id: true, repositoryId: true },
  });
  if (!predecessor) {
    return reply.code(404).send({ error: 'Task not found' });
  }

  // null = clear the link.
  if (body.nextTaskId === null) {
    const updated = await prisma.task.update({
      where: { id: predecessor.id },
      data: { nextTaskId: null },
    });
    return { task: updated };
  }

  if (body.nextTaskId === predecessor.id) {
    return reply.code(400).send({ error: 'A task cannot follow itself' });
  }

  // The successor must exist, live in the same repository as the
  // predecessor, be owned by the same user, and not be archived (the
  // dropdown lists every active status, so an archived task is the only
  // invalid pick).
  const successor = await prisma.task.findFirst({
    where: {
      ...ownedTaskWhere(userId, body.nextTaskId),
      repositoryId: predecessor.repositoryId,
      archivedAt: null,
    },
    select: { id: true },
  });
  if (!successor) {
    return reply
      .code(400)
      .send({ error: 'Follow-up task not found in this repository' });
  }

  try {
    const updated = await prisma.task.update({
      where: { id: predecessor.id },
      data: { nextTaskId: successor.id },
    });
    return { task: updated };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003' // foreign-key violation (successor id missing)
    ) {
      return reply.code(400).send({ error: 'Follow-up task not found' });
    }
    throw error;
  }
}
