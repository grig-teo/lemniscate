import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { queueDeployment } from '../lib/deploy/deploy-service.js';
import { servicePath, slugify } from '../lib/deploy/slug.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { serviceEnvRoutes } from './services-env.js';
import { serviceLifecycleRoutes } from './services-lifecycle.js';
import { serviceLogRoutes } from './services-logs.js';
import { envKeys, idParamsSchema, ownedService } from './services-shared.js';

// Services (Lemniscate Apps): one deployable container per repository,
// routed at apps.grig-teo.space/<connection.username>/<service.name>.
// Env vars live in services-env.ts, deployments/logs in services-logs.ts,
// stop/delete in services-lifecycle.ts; the Traefik provider and the apps
// index are re-exported from services-internal.ts / services-apps-index.ts.

const createBodySchema = z
  .object({
    repositoryId: z.string().min(1),
    name: z.string().min(1).max(100).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    autoDeploy: z.boolean().optional(),
    // Where to deploy: the platform apps network (default) or the user's VPS.
    deployTarget: z.enum(['lemniscate', 'vps']).optional(),
    // Required when deployTarget='vps'; ignored otherwise.
    vpsTargetId: z.string().min(1).optional(),
  })
  .strict();

const patchBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    autoDeploy: z.boolean().optional(),
    deployTarget: z.enum(['lemniscate', 'vps']).optional(),
    vpsTargetId: z.string().min(1).nullable().optional(),
  })
  .strict();

function serviceUrl(ownerUsername: string, name: string): string {
  return `${config.APPS_BASE_URL}${servicePath(ownerUsername, name)}`;
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

// Public service shape: envEnc stripped (keys only), url computed. VPS
// services carry their profile summary so the UI can show host:port without
// a second round-trip. Accepts a row that may or may not include `vpsTarget`.
type ServiceRow = {
  id: string;
  repositoryId: string;
  name: string;
  port: number;
  hostPort: number | null;
  envEnc: string | null;
  autoDeploy: boolean;
  status: string;
  activeContainer: string | null;
  deployTarget: 'lemniscate' | 'vps';
  vpsTargetId: string | null;
  createdAt: Date;
  updatedAt: Date;
  vpsTarget?: { id: string; name: string; host: string; port: number } | null;
};

// VPS services are reachable at http://<vps-host>:<hostPort>; lemniscate
// services at the platform apps URL. For legacy VPS services without an
// allocated hostPort, the container port is used (they deployed as port:port).
function computeServiceUrl(service: ServiceRow, ownerUsername: string): string {
  if (service.deployTarget === 'vps' && service.vpsTarget) {
    const exposedPort = service.hostPort ?? service.port;
    return `http://${service.vpsTarget.host}:${exposedPort}`;
  }
  return serviceUrl(ownerUsername, service.name);
}

function serializeService(
  service: ServiceRow,
  ownerUsername: string,
  deployments: unknown[] = [],
): Record<string, unknown> {
  const { envEnc, vpsTarget, ...rest } = service;
  const publicTarget = vpsTarget
    ? { id: vpsTarget.id, name: vpsTarget.name, host: vpsTarget.host, port: vpsTarget.port }
    : undefined;
  return {
    ...rest,
    envKeys: envEnc ? envKeys(envEnc) : [],
    url: computeServiceUrl(service, ownerUsername),
    ...(publicTarget ? { vpsTarget: publicTarget } : {}),
    deployments,
  };
}

// Validates the deployTarget/vpsTargetId pair: 'vps' requires an owned
// VpsTarget; 'lemniscate' must clear any vpsTargetId. Returns the normalized
// {deployTarget, vpsTargetId} to persist, or null (with reply sent) on error.
async function resolveDeployTarget(
  userId: string,
  deployTarget: 'lemniscate' | 'vps' | undefined,
  vpsTargetId: string | null | undefined,
  reply: FastifyReply,
): Promise<{ deployTarget: 'lemniscate' | 'vps'; vpsTargetId: string | null } | null> {
  const target = deployTarget ?? 'lemniscate';
  if (target === 'lemniscate') return { deployTarget: 'lemniscate', vpsTargetId: null };
  if (!vpsTargetId) {
    reply.code(400).send({ error: 'vpsTargetId is required when deployTarget is "vps"' });
    return null;
  }
  const owned = await prisma.vpsTarget.findFirst({
    where: { id: vpsTargetId, userId },
    select: { id: true },
  });
  if (!owned) {
    reply.code(404).send({ error: 'VPS target not found' });
    return null;
  }
  return { deployTarget: 'vps', vpsTargetId };
}

// Allocates a distinct host port for a VPS service. Each VPS target gets its
// own [30000, 39999] range; the lowest free port is handed out so two apps
// with the same container port (e.g. both defaulting to 80) don't collide.
const HOST_PORT_RANGE_START = 30000;
const HOST_PORT_RANGE_END = 39999;

async function allocateHostPort(vpsTargetId: string): Promise<number> {
  const used = await prisma.service.findMany({
    where: { vpsTargetId, hostPort: { not: null } },
    select: { hostPort: true },
  });
  const taken = new Set(used.map((s) => s.hostPort as number));
  for (let p = HOST_PORT_RANGE_START; p <= HOST_PORT_RANGE_END; p += 1) {
    if (!taken.has(p)) return p;
  }
  throw new Error('No free host ports in the VPS allocation range (30000-39999)');
}

// Returns an existing hostPort or allocates a new one for VPS services; null
// for lemniscate services. Called after resolveDeployTarget succeeds.
async function ensureHostPort(
  deployTarget: 'lemniscate' | 'vps',
  vpsTargetId: string | null,
  existingHostPort: number | null,
): Promise<number | null> {
  if (deployTarget !== 'vps' || !vpsTargetId) return null;
  if (existingHostPort) return existingHostPort;
  return allocateHostPort(vpsTargetId);
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
        vpsTarget: { select: { id: true, name: true, host: true, port: true } },
        deployments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      services: services.map((svc) =>
        serializeService(svc, svc.repository.connection.username, svc.deployments),
      ),
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
    const target = await resolveDeployTarget(userId, data.deployTarget, data.vpsTargetId, reply);
    if (target === null) return;
    const hostPort = await ensureHostPort(target.deployTarget, target.vpsTargetId, null);
    const service = await prisma.service.create({
      data: {
        repositoryId: repository.id,
        name: slug,
        ...(data.port !== undefined ? { port: data.port } : {}),
        ...(data.autoDeploy !== undefined ? { autoDeploy: data.autoDeploy } : {}),
        deployTarget: target.deployTarget,
        vpsTargetId: target.vpsTargetId,
        ...(hostPort !== null ? { hostPort } : {}),
      },
      include: { vpsTarget: { select: { id: true, name: true, host: true, port: true } } },
    });
    return reply.code(201).send({ service: serializeService(service, owner) });
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
    const update: { name?: string; port?: number; autoDeploy?: boolean; deployTarget?: 'lemniscate' | 'vps'; vpsTargetId?: string | null; hostPort?: number } = {};
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
    if (data.deployTarget !== undefined || data.vpsTargetId !== undefined) {
      const target = await resolveDeployTarget(
        userId,
        data.deployTarget ?? service.deployTarget,
        data.vpsTargetId === undefined ? service.vpsTargetId : data.vpsTargetId,
        reply,
      );
      if (target === null) return;
      update.deployTarget = target.deployTarget;
      update.vpsTargetId = target.vpsTargetId;
      const hostPort = await ensureHostPort(target.deployTarget, target.vpsTargetId, service.hostPort);
      if (hostPort !== null) update.hostPort = hostPort;
    }
    const updated = await prisma.service.update({
      where: { id: service.id },
      data: update,
      include: { vpsTarget: { select: { id: true, name: true, host: true, port: true } } },
    });
    return { service: serializeService(updated, owner) };
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

  await app.register(serviceEnvRoutes);
  await app.register(serviceLogRoutes);
  await app.register(serviceLifecycleRoutes);
};

export { servicesInternalRoutes } from './services-internal.js';
export { appsIndexRoute } from './services-apps-index.js';

export default servicesRoutes;
