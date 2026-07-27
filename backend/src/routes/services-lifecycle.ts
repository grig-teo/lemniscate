import type { FastifyPluginAsync } from 'fastify';
import { stopRemoveContainer } from '../lib/deploy/docker-apps.js';
import { stopVpsContainer } from '../lib/deploy/vps-deploy.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { idParamsSchema, ownedService } from './services-shared.js';

// Service stop/delete: both tear down the live container first — on the
// user's VPS for VPS services, on the platform host otherwise.

export const serviceLifecycleRoutes: FastifyPluginAsync = async (app) => {
  app.post('/services/:id/stop', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid id');
    if (params === null) return;
    const service = await ownedService(userId, params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });
    if (service.activeContainer) {
      if (service.deployTarget === 'vps') {
        await stopVpsContainer(service.vpsTarget, service.activeContainer);
      } else {
        await stopRemoveContainer(service.activeContainer);
      }
    }
    const updated = await prisma.service.update({
      where: { id: service.id },
      data: { activeContainer: null, status: 'stopped' },
    });
    return { service: updated };
  });

  app.delete('/services/:id', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid id');
    if (params === null) return;
    const service = await ownedService(userId, params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });
    if (service.activeContainer) {
      if (service.deployTarget === 'vps') {
        await stopVpsContainer(service.vpsTarget, service.activeContainer);
      } else {
        await stopRemoveContainer(service.activeContainer);
      }
    }
    await prisma.service.delete({ where: { id: service.id } });
    return reply.code(204).send();
  });
};
