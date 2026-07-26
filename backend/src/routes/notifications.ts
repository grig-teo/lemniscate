import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decrypt, encrypt } from '../lib/crypto.js';
import { generateWebhookSecret } from '../lib/notifications.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// User notifications API: in-app list/read endpoints for the TopNav bell,
// plus the per-user outbound webhook settings (Slack/Discord/Telegram
// bridges POST Lemniscate events, HMAC-signed — see lib/notifications.ts).
// Registered under prefix `/api/notifications` (app.ts).

const LIST_TAKE = 50;
const SETTINGS_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

const listQuerySchema = z.object({
  unread: z.enum(['true', 'false']).optional(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });

const settingsBodySchema = z.object({
  webhookUrl: z
    .string()
    .url()
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
      message: 'webhookUrl must be an http(s) URL',
    })
    .nullable(),
});

async function listNotifications(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const query = parseOrReply(listQuerySchema, request.query, reply, 'Invalid query');
  if (!query) return;
  const where = { userId, ...(query.unread === 'true' ? { readAt: null } : {}) };
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: LIST_TAKE }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return reply.send({ notifications, unreadCount });
}

async function markRead(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid notification id');
  if (!params) return;
  // Ownership scoping: updateMany with userId in the where — a foreign id is
  // a silent no-op (same 404-less pattern as read-all), never a cross-user write.
  const { count } = await prisma.notification.updateMany({
    where: { id: params.id, userId, readAt: null },
    data: { readAt: new Date() },
  });
  return reply.send({ updated: count });
}

async function markAllRead(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const { count } = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return reply.send({ updated: count });
}

function settingsResponse(user: { webhookUrl: string | null; webhookSecretEnc: string | null }) {
  return {
    webhookUrl: user.webhookUrl,
    webhookSecret: user.webhookSecretEnc ? decrypt(user.webhookSecretEnc) : null,
  };
}

async function getSettings(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { webhookUrl: true, webhookSecretEnc: true },
  });
  return reply.send(settingsResponse(user));
}

async function putSettings(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const body = parseOrReply(settingsBodySchema, request.body, reply, 'Invalid settings', {
    includeIssues: true,
    request,
  });
  if (!body) return;
  const current = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { webhookSecretEnc: true },
  });
  // Setting a URL without an existing secret mints one; clearing the URL
  // keeps the secret so re-enabling does not break the bridge config.
  const secretEnc =
    body.webhookUrl !== null && current.webhookSecretEnc === null
      ? encrypt(generateWebhookSecret())
      : current.webhookSecretEnc;
  const user = await prisma.user.update({
    where: { id: userId },
    data: { webhookUrl: body.webhookUrl, webhookSecretEnc: secretEnc },
    select: { webhookUrl: true, webhookSecretEnc: true },
  });
  return reply.send(settingsResponse(user));
}

const notificationsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.get('/', listNotifications);
  app.post('/:id/read', markRead);
  app.post('/read-all', markAllRead);
  app.get('/settings', getSettings);
  app.put('/settings', { config: { rateLimit: SETTINGS_RATE_LIMIT } }, putSettings);
};

export default notificationsRoutes;
