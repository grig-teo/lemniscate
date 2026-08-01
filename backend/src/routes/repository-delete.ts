// DELETE /repositories/:id — permanently removes a repository owned by the
// caller. Kept out of routes/repositories.ts, which sits at the max-lines
// baseline. Related rows (tasks, event triggers, service, webhooks, …)
// cascade per the Prisma schema; the remote repository on the provider is
// NOT touched.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

const repositoryDeleteRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.delete('/repositories/:id', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid repository id');
    if (params === null) return;

    const repository = await prisma.repository.findFirst({
      where: { id: params.id, connection: { userId } },
      select: { id: true },
    });
    if (!repository) {
      return reply.code(404).send({ error: 'Repository not found' });
    }

    await prisma.repository.delete({ where: { id: repository.id } });
    return reply.code(204).send();
  });
};

export default repositoryDeleteRoutes;
