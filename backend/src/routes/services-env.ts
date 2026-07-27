import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { encrypt, decrypt } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { envKeys, idParamsSchema, ownedService } from './services-shared.js';

// Service env vars. Env vars are write-only over the API (same convention as
// LLM API keys): the GET returns names only, never values.

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

export const serviceEnvRoutes: FastifyPluginAsync = async (app) => {
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
};
