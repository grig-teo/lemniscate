import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { queueDeployment } from '../lib/deploy/deploy-service.js';
import { stopRemoveContainer, tailContainerLogs } from '../lib/deploy/docker-apps.js';
import { stopVpsContainer } from '../lib/deploy/vps-deploy.js';
import { servicePath, slugify } from '../lib/deploy/slug.js';
import { buildTraefikConfig } from '../lib/deploy/traefik-config.js';
import { prisma } from '../lib/prisma.js';
import { safeEqualSecret } from '../lib/secret-compare.js';
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
      vpsTarget: { select: { id: true, name: true, host: true, port: true, username: true, authMethod: true, secretEnc: true } },
      deployments: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
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

// Public HTML index of one owner's live apps — Traefik rewrites /<owner>/*
// here (replacePath) for paths no service claimed. Public by design: the
// service URLs themselves are publicly reachable. Mounted under /api.
const APPS_INDEX_ROUTE = '/apps-index/:owner';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export const appsIndexRoute: FastifyPluginAsync = async (app) => {
  app.get(APPS_INDEX_ROUTE, async (request, reply) => {
    const { owner } = request.params as { owner: string };
    const services = await prisma.service.findMany({
      where: { deployTarget: 'lemniscate', status: 'online', activeContainer: { not: null } },
      include: { repository: { include: { connection: { select: { username: true } } } } },
    });
    const owned = services.filter(
      (svc) => slugify(svc.repository.connection.username) === owner,
    );
    const items = owned
      .map(
        (svc) =>
          `      <li><a href="/${escapeHtml(owner)}/${escapeHtml(svc.name)}/">${escapeHtml(svc.name)}</a>` +
          `<span class="repo">${escapeHtml(svc.repository.fullName)}</span></li>`,
      )
      .join('\n');
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(owner)} — Lemniscate Apps</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #1f2328; }
    h1 { font-size: 1.4rem; }
    ul { list-style: none; padding: 0; }
    li { display: flex; align-items: baseline; gap: .75rem; padding: .6rem 0; border-bottom: 1px solid #e5e7eb; }
    a { color: #0969da; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
    .repo { color: #6e7781; font-size: .85rem; }
    .empty { color: #6e7781; }
    footer { margin-top: 3rem; color: #6e7781; font-size: .8rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(owner)} — deployed apps</h1>
${items ? `  <ul>\n${items}\n  </ul>` : '  <p class="empty">No apps deployed yet.</p>'}
  <footer>Powered by Lemniscate</footer>
</body>
</html>`;
    return reply.type('text/html').send(html);
  });
};

export default servicesRoutes;
