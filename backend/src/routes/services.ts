import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { queueDeployment } from '../lib/deploy/deploy-service.js';
import { stopRemoveContainer, tailContainerLogs } from '../lib/deploy/docker-apps.js';
import { servicePath, slugify } from '../lib/deploy/slug.js';
import { buildTraefikConfig } from '../lib/deploy/traefik-config.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// Services (Lemniscate Apps): one deployable container per repository,
// routed at apps.grig-teo.space/<connection.username>/<service.name>.

const idParamsSchema = z.object({ id: z.string().min(1) });

const createBodySchema = z
  .object({
    repositoryId: z.string().min(1),
    name: z.string().min(1).max(100).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    autoDeploy: z.boolean().optional(),
  })
  .strict();

const patchBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    autoDeploy: z.boolean().optional(),
  })
  .strict();

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Merge semantics (values are write-only over the API): `set` adds/replaces
// keys, `remove` deletes them — a full replace would force users to re-enter
// every secret on each edit.
const envBodySchema = z
  .object({
    set: z.record(z.string().regex(ENV_KEY_PATTERN, 'invalid env var name'), z.string().max(4_096)),
    remove: z.array(z.string().regex(ENV_KEY_PATTERN)).max(64),
  })
  .strict();

function serviceUrl(ownerUsername: string, name: string): string {
  return `${config.APPS_BASE_URL}${servicePath(ownerUsername, name)}`;
}

// envEnc holds AES-256-GCM JSON; keys are safe to list, values never are.
function envKeys(envEnc: string): string[] {
  try {
    return Object.keys(JSON.parse(decrypt(envEnc)) as Record<string, string>);
  } catch {
    return [];
  }
}

// 409 when another service already owns /<owner>/<slug>.
async function slugTaken(ownerUsername: string, slug: string, excludeId?: string): Promise<boolean> {
  const clash = await prisma.service.findFirst({
    where: {
      name: slug,
      repository: { connection: { username: ownerUsername } },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  return clash !== null;
}

async function ownedService(userId: string, id: string) {
  return prisma.service.findFirst({
    where: { id, repository: { connection: { userId } } },
    include: {
      repository: {
        select: {
          id: true,
          fullName: true,
          defaultBranch: true,
          connection: { select: { username: true, provider: true } },
        },
      },
      deployments: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
}

const servicesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/services', async (request) => {
    const userId = authenticatedUserId(request);
    const services = await prisma.service.findMany({
      where: { repository: { connection: { userId } } },
      include: {
        repository: {
          select: { fullName: true, connection: { select: { username: true, provider: true } } },
        },
        deployments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      services: services.map((svc) => {
        const { envEnc, ...rest } = svc;
        return {
          ...rest,
          envKeys: envEnc ? envKeys(envEnc) : [],
          url: serviceUrl(svc.repository.connection.username, svc.name),
        };
      }),
    };
  });

  app.post('/services', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const data = parseOrReply(createBodySchema, request.body, reply, 'Invalid body');
    if (data === null) return;
    const repository = await prisma.repository.findFirst({
      where: { id: data.repositoryId, connection: { userId } },
      include: { connection: { select: { username: true } }, service: { select: { id: true } } },
    });
    if (!repository) return reply.code(404).send({ error: 'Repository not found' });
    if (repository.service) {
      return reply.code(409).send({ error: 'This repository already has a service' });
    }
    const owner = repository.connection.username;
    const slug = slugify(data.name ?? repository.name);
    if (!slug) return reply.code(400).send({ error: 'Service name has no usable characters' });
    if (await slugTaken(owner, slug)) {
      return reply.code(409).send({ error: `/${owner}/${slug} is already taken` });
    }
    const service = await prisma.service.create({
      data: {
        repositoryId: repository.id,
        name: slug,
        ...(data.port !== undefined ? { port: data.port } : {}),
        ...(data.autoDeploy !== undefined ? { autoDeploy: data.autoDeploy } : {}),
      },
    });
    return reply.code(201).send({ service: { ...service, url: serviceUrl(owner, slug) } });
  });

  app.patch('/services/:id', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid id');
    if (params === null) return;
    const data = parseOrReply(patchBodySchema, request.body, reply, 'Invalid body');
    if (data === null) return;
    const service = await ownedService(userId, params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });
    const owner = service.repository.connection.username;
    const update: { name?: string; port?: number; autoDeploy?: boolean } = {};
    if (data.name !== undefined) {
      const slug = slugify(data.name);
      if (!slug) return reply.code(400).send({ error: 'Service name has no usable characters' });
      if (slug !== service.name && (await slugTaken(owner, slug, service.id))) {
        return reply.code(409).send({ error: `/${owner}/${slug} is already taken` });
      }
      update.name = slug;
    }
    if (data.port !== undefined) update.port = data.port;
    if (data.autoDeploy !== undefined) update.autoDeploy = data.autoDeploy;
    const updated = await prisma.service.update({ where: { id: service.id }, data: update });
    return { service: { ...updated, url: serviceUrl(owner, updated.name) } };
  });

  // Env vars are write-only over the API (same convention as LLM API keys):
  // the GET returns names only, never values.
  app.get('/services/:id/env', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid id');
    if (params === null) return;
    const service = await ownedService(userId, params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });
    return { keys: service.envEnc ? envKeys(service.envEnc) : [] };
  });

  app.put('/services/:id/env', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid id');
    if (params === null) return;
    const data = parseOrReply(envBodySchema, request.body, reply, 'Invalid body', {
      includeIssues: true,
    });
    if (data === null) return;
    const service = await ownedService(userId, params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });
    const current: Record<string, string> = service.envEnc
      ? (JSON.parse(decrypt(service.envEnc)) as Record<string, string>)
      : {};
    for (const key of data.remove) delete current[key];
    Object.assign(current, data.set);
    const keys = Object.keys(current);
    if (keys.length > 64) {
      return reply.code(400).send({ error: 'At most 64 env vars' });
    }
    await prisma.service.update({
      where: { id: service.id },
      data: { envEnc: keys.length > 0 ? encrypt(JSON.stringify(current)) : null },
    });
    return { keys };
  });

  app.post('/services/:id/deploy', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid id');
    if (params === null) return;
    const service = await ownedService(userId, params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });
    const deployment = await queueDeployment(service.id, null);
    await prisma.service.update({ where: { id: service.id }, data: { status: 'deploying' } });
    return reply.code(202).send({ deployment });
  });

  app.post('/services/:id/stop', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid id');
    if (params === null) return;
    const service = await ownedService(userId, params.id);
    if (!service) return reply.code(404).send({ error: 'Service not found' });
    if (service.activeContainer) await stopRemoveContainer(service.activeContainer);
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
    if (service.activeContainer) await stopRemoveContainer(service.activeContainer);
    await prisma.service.delete({ where: { id: service.id } });
    return reply.code(204).send();
  });

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

// Traefik HTTP provider: routers for every service with a live container.
// Guarded by a shared secret instead of a session — only the Traefik
// container (and the host) can reach the backend on the internal network.
export const servicesInternalRoutes: FastifyPluginAsync = async (app) => {
  app.get('/internal/traefik/dynamic', async (request, reply) => {
    if (!config.TRAEFIK_PROVIDER_TOKEN) {
      return reply.code(503).send({ error: 'traefik provider is not configured' });
    }
    if (request.headers['x-traefik-token'] !== config.TRAEFIK_PROVIDER_TOKEN) {
      return reply.code(401).send({ error: 'invalid traefik token' });
    }
    const services = await prisma.service.findMany({
      where: { status: 'online', activeContainer: { not: null } },
      include: { repository: { include: { connection: { select: { username: true } } } } },
    });
    return buildTraefikConfig(
      services.map((svc) => ({
        ownerUsername: svc.repository.connection.username,
        name: svc.name,
        port: svc.port,
        activeContainer: svc.activeContainer as string,
      })),
    );
  });
};

export default servicesRoutes;
