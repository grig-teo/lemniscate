import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { TRIGGERABLE_EVENT_KINDS } from '../lib/event-trigger-handler.js';

// CRUD for EventTrigger rows (POST/GET/PATCH/DELETE /api/repositories/:id/triggers).
// Every route is scoped to the authenticated user's repositories (owner check
// via connection.userId), matching the existing repository route pattern.

const repoIdParamsSchema = z.object({ id: z.string().min(1) });

const triggerIdParamsSchema = z.object({
  id: z.string().min(1),
  triggerId: z.string().min(1),
});

// z.enum needs a mutable tuple; spread the readonly array into a new one.
const eventKindEnum = z.enum([...TRIGGERABLE_EVENT_KINDS] as ['ci_failed', 'issue_opened']);

const createTriggerBodySchema = z
  .object({
    eventKind: eventKindEnum,
    taskPrompt: z.string().min(1).max(5000),
    enabled: z.boolean().optional(),
  })
  .strict();

const patchTriggerBodySchema = z
  .object({
    taskPrompt: z.string().min(1).max(5000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

type PatchTriggerBody = z.infer<typeof patchTriggerBodySchema>;

// Verifies the repository belongs to the authenticated user; returns the row
// or null. The select matches what the trigger queries need.
async function findOwnedRepository(userId: string, repositoryId: string) {
  return prisma.repository.findFirst({
    where: { id: repositoryId, connection: { userId } },
    select: { id: true },
  });
}

// Only writes the fields that were actually sent (same pattern as repositories).
function buildPatchData(data: PatchTriggerBody) {
  return {
    ...(data.taskPrompt !== undefined ? { taskPrompt: data.taskPrompt } : {}),
    ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
  };
}

// Prisma unique-constraint errors carry code P2002.
function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  );
}

const eventTriggersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  // List all triggers for a repository.
  app.get('/repositories/:id/triggers', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(repoIdParamsSchema, request.params, reply, 'Invalid repository id');
    if (params === null) return;
    const repository = await findOwnedRepository(userId, params.id);
    if (!repository) return reply.code(404).send({ error: 'Repository not found' });
    const triggers = await prisma.eventTrigger.findMany({
      where: { repositoryId: params.id },
      orderBy: { eventKind: 'asc' },
    });
    return { triggers };
  });

  // Create a new trigger on a repository.
  app.post('/repositories/:id/triggers', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(repoIdParamsSchema, request.params, reply, 'Invalid repository id');
    if (params === null) return;
    const data = parseOrReply(createTriggerBodySchema, request.body, reply, 'Invalid body', {
      includeIssues: true,
    });
    if (data === null) return;
    const repository = await findOwnedRepository(userId, params.id);
    if (!repository) return reply.code(404).send({ error: 'Repository not found' });
    try {
      const trigger = await prisma.eventTrigger.create({
        data: {
          repositoryId: params.id,
          eventKind: data.eventKind,
          taskPrompt: data.taskPrompt,
          enabled: data.enabled ?? true,
        },
      });
      return reply.code(201).send({ trigger });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({ error: 'A trigger for this event kind already exists' });
      }
      throw err;
    }
  });

  // Update a trigger (prompt text or enabled flag).
  app.patch('/repositories/:id/triggers/:triggerId', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(triggerIdParamsSchema, request.params, reply, 'Invalid parameters');
    if (params === null) return;
    const data = parseOrReply(patchTriggerBodySchema, request.body, reply, 'Invalid body', {
      includeIssues: true,
    });
    if (data === null) return;
    const repository = await findOwnedRepository(userId, params.id);
    if (!repository) return reply.code(404).send({ error: 'Repository not found' });

    const updated = await prisma.eventTrigger.updateMany({
      where: { id: params.triggerId, repositoryId: params.id },
      data: buildPatchData(data),
    });
    if (updated.count === 0) {
      return reply.code(404).send({ error: 'Trigger not found' });
    }
    const trigger = await prisma.eventTrigger.findUnique({
      where: { id: params.triggerId },
    });
    return { trigger };
  });

  // Delete a trigger.
  app.delete('/repositories/:id/triggers/:triggerId', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(triggerIdParamsSchema, request.params, reply, 'Invalid parameters');
    if (params === null) return;
    const repository = await findOwnedRepository(userId, params.id);
    if (!repository) return reply.code(404).send({ error: 'Repository not found' });

    const result = await prisma.eventTrigger.deleteMany({
      where: { id: params.triggerId, repositoryId: params.id },
    });
    if (result.count === 0) {
      return reply.code(404).send({ error: 'Trigger not found' });
    }
    return reply.code(204).send();
  });
};

export default eventTriggersRoutes;
