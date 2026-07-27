import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { VpsTarget } from '@prisma/client';
import { z } from 'zod';
import { encrypt, decrypt } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { requireAuth, authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { testVpsConnection } from '../lib/deploy/vps.js';

// VPS deployment target CRUD + connectivity-test endpoints. A VpsTarget is a
// reusable SSH connection profile (host/port/user + password or private key)
// that a Service with deployTarget='vps' deploys onto. Register under
// `/api/vps-targets` (done in app.ts).

// Keep the test endpoint bucket tight — it dials the user's host over SSH.
const TEST_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

const hostField = z
  .string()
  .min(1)
  .max(253)
  // Hostname or IPv4; rejects anything with a scheme/path (a URL is a mistake).
  .refine((value) => /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value), {
    message: 'host must be a hostname or IP (no scheme or path)',
  });

const targetFields = {
  name: z.string().min(1).max(100),
  host: hostField,
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(100),
  authMethod: z.enum(['password', 'key']).default('password'),
};

const createSchema = z
  .object({
    ...targetFields,
    // password (authMethod='password') or PEM private key (authMethod='key').
    secret: z.string().min(1).max(16_384),
  })
  .strict();

const updateSchema = z
  .object({
    ...targetFields,
    // Omit `secret` to keep the stored credential; send it to replace.
    secret: z.string().min(1).max(16_384).optional(),
  })
  .strict();

// Test payload: a full unsaved target (so the user can validate before save).
const testSchema = z
  .object({
    ...targetFields,
    secret: z.string().min(1).max(16_384),
  })
  .strict();

const idParamSchema = z.object({ id: z.string().min(1) });

// Never expose secretEnc over the API — only a boolean hasSecret.
function serialize(record: VpsTarget) {
  const { secretEnc: _secretEnc, ...rest } = record;
  return { ...rest, hasSecret: true };
}

// --- Plugin ---

const vpsTargetRoutes = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  app.get('/vps-targets', async (request) => {
    const userId = authenticatedUserId(request);
    const targets = await prisma.vpsTarget.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
    });
    return { targets: targets.map(serialize) };
  });

  app.post('/vps-targets', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const data = parseOrReply(createSchema, request.body, reply, 'Invalid request body', {
      includeIssues: true,
      request,
    });
    if (data === null) return;
    const created = await prisma.vpsTarget.create({
      data: {
        userId,
        name: data.name,
        host: data.host,
        port: data.port,
        username: data.username,
        authMethod: data.authMethod,
        secretEnc: encrypt(data.secret),
      },
    });
    return reply.code(201).send({ target: serialize(created) });
  });

  app.patch('/vps-targets/:id', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid id');
    if (params === null) return;
    const data = parseOrReply(updateSchema, request.body, reply, 'Invalid request body', {
      includeIssues: true,
      request,
    });
    if (data === null) return;
    const existing = await prisma.vpsTarget.findFirst({
      where: { id: params.id, userId },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'VPS target not found' });
    const { secret, ...fields } = data;
    const updated = await prisma.vpsTarget.update({
      where: { id: params.id },
      data: {
        ...fields,
        ...(secret !== undefined ? { secretEnc: encrypt(secret) } : {}),
      },
    });
    return { target: serialize(updated) };
  });

  app.delete('/vps-targets/:id', async (request, reply) => {
    const userId = authenticatedUserId(request);
    const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid id');
    if (params === null) return;
    const existing = await prisma.vpsTarget.findFirst({
      where: { id: params.id, userId },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'VPS target not found' });
    // Services referencing this target fall back to 'lemniscate' (SetNull on
    // the FK); we also reset their deployTarget so a stale 'vps' choice does
    // not try to deploy to a now-deleted profile.
    await prisma.service.updateMany({
      where: { vpsTargetId: params.id },
      data: { vpsTargetId: null, deployTarget: 'lemniscate' },
    });
    await prisma.vpsTarget.delete({ where: { id: params.id } });
    return reply.code(204).send();
  });

  // Connectivity probe against an UNSAVED target (validate before save) or a
  // saved one (when no body is sent).
  app.post(
    '/vps-targets/:id/test',
    { config: { rateLimit: TEST_RATE_LIMIT } },
    async (request, reply) => {
      const userId = authenticatedUserId(request);
      const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid id');
      if (params === null) return;
      const target = await prisma.vpsTarget.findFirst({
        where: { id: params.id, userId },
      });
      if (!target) return reply.code(404).send({ error: 'VPS target not found' });
      const result = await testVpsConnection(
        {
          host: target.host,
          port: target.port,
          username: target.username,
          authMethod: target.authMethod === 'key' ? 'key' : 'password',
        },
        decrypt(target.secretEnc),
      );
      return result;
    },
  );

  // Validate an unsaved target (create dialog "Test" button).
  app.post(
    '/vps-targets/test',
    { config: { rateLimit: TEST_RATE_LIMIT } },
    async (request, reply) => {
      const data = parseOrReply(testSchema, request.body, reply, 'Invalid request body', {
        includeIssues: true,
        request,
      });
      if (data === null) return;
      const result = await testVpsConnection(
        {
          host: data.host,
          port: data.port,
          username: data.username,
          authMethod: data.authMethod,
        },
        data.secret,
      );
      return result;
    },
  );
};

export default vpsTargetRoutes;
