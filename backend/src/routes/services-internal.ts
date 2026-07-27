import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { buildTraefikConfig } from '../lib/deploy/traefik-config.js';
import { prisma } from '../lib/prisma.js';
import { safeEqualSecret } from '../lib/secret-compare.js';

// Traefik HTTP provider: routers for every service with a live container.
// Guarded by a shared secret instead of a session — only the Traefik
// container (and the host) can reach the backend on the internal network.
export const servicesInternalRoutes: FastifyPluginAsync = async (app) => {
  app.get('/internal/traefik/dynamic', async (request, reply) => {
    if (!config.TRAEFIK_PROVIDER_TOKEN) {
      return reply.code(503).send({ error: 'traefik provider is not configured' });
    }
    if (!safeEqualSecret(request.headers['x-traefik-token'], config.TRAEFIK_PROVIDER_TOKEN)) {
      return reply.code(401).send({ error: 'invalid traefik token' });
    }
    const services = await prisma.service.findMany({
      where: { deployTarget: 'lemniscate', status: 'online', activeContainer: { not: null } },
      include: { repository: { include: { connection: { select: { username: true } } } } },
    });
    return buildTraefikConfig(
      services.map((svc) => ({
        ownerUsername: svc.repository.connection.username,
        name: svc.name,
        port: svc.port,
        activeContainer: svc.activeContainer as string,
      })),
      config.TRAEFIK_BACKEND_URL,
    );
  });
};
