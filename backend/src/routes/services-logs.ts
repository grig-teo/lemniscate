import type { FastifyPluginAsync } from 'fastify';
import { tailContainerLogs } from '../lib/deploy/docker-apps.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { idParamsSchema, ownedService } from './services-shared.js';

// Deployment history and live container logs for a service.

export const serviceLogRoutes: FastifyPluginAsync = async (app) => {
  app.get('/services/:id/deployments', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid id');
    if (params === null) return;
    const service = await ownedService(userId, params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });
    const deployments = await prisma.deployment.findMany({
      where: { serviceId: service.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        taskId: true,
        commitSha: true,
        status: true,
        log: true,
        createdAt: true,
        finishedAt: true,
      },
    });
    return { deployments };
  });

  // Live container logs (last 200 lines) for the running service.
  app.get('/services/:id/logs', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid id');
    if (params === null) return;
    const service = await ownedService(userId, params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });
    if (!service.activeContainer) return reply.code(409).send({ error: 'Service is not running' });
    return { log: await tailContainerLogs(service.activeContainer, 200) };
  });
};
