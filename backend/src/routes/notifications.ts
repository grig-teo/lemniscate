import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decrypt, encrypt } from '../lib/crypto.js';
import {
  generateWebhookSecret,
  sendTestNotification,
} from '../lib/notification-delivery.js';
import { NOTIFICATION_KINDS } from '../lib/notifications.js';
import { prisma } from '../lib/prisma.js';
import { assertPublicHttpUrl } from '../lib/url-safety.js';
import { errorMessage } from '../lib/utils.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// User notifications API: in-app list/read endpoints for the TopNav bell,
// plus CRUD for outbound notification channels (NotificationSetting rows —
// HMAC-signed webhooks and email, delivered retried via the
// 'notification-delivery' BullMQ job; see lib/notification-delivery.ts).
// Registered under prefix `/api/notifications` (app.ts).

const LIST_TAKE = 50;
const DELIVERIES_TAKE = 20;
const SETTINGS_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

const listQuerySchema = z.object({
  unread: z.enum(['true', 'false']).optional(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });

const channelBodySchema = z.object({
  channel: z.enum(['webhook', 'email']),
  target: z.string().min(1).max(500),
  events: z.array(z.enum(NOTIFICATION_KINDS)).min(1),
  enabled: z.boolean().optional(),
});

const channelPatchSchema = z
  .object({
    target: z.string().min(1).max(500).optional(),
    events: z.array(z.enum(NOTIFICATION_KINDS)).min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'at least one field must be provided',
  });

// ---------------------------------------------------------------------------
// In-app notifications (TopNav bell)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Outbound channels
// ---------------------------------------------------------------------------

interface SettingRow {
  id: string;
  channel: string;
  target: string;
  secretEnc: string | null;
  events: string[];
  enabled: boolean;
  createdAt: Date;
}

interface DeliveryRow {
  id: string;
  event: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: Date;
}

function deliveryResponse(delivery: DeliveryRow) {
  return {
    id: delivery.id,
    event: delivery.event,
    status: delivery.status,
    attempts: delivery.attempts,
    lastStatusCode: delivery.lastStatusCode,
    lastError: delivery.lastError,
    createdAt: delivery.createdAt,
  };
}

// The HMAC secret is returned in plaintext (the user wires it into their
// bridge) — it is only ever stored AES-256-GCM encrypted.
function channelResponse(setting: SettingRow, lastDelivery?: DeliveryRow | null) {
  return {
    id: setting.id,
    channel: setting.channel,
    target: setting.target,
    events: setting.events,
    enabled: setting.enabled,
    createdAt: setting.createdAt,
    webhookSecret: setting.secretEnc ? decrypt(setting.secretEnc) : null,
    lastDelivery: lastDelivery ? deliveryResponse(lastDelivery) : null,
  };
}

// Target validation at save time: webhook URLs must be public http(s)
// (SSRF — re-checked at delivery time too, DNS rebinding window accepted as
// with LLM base URLs); email targets must be syntactically valid.
async function targetValid(channel: string, target: string): Promise<boolean> {
  if (channel === 'email') {
    return z.string().email().safeParse(target).success;
  }
  const parsed = URL.canParse(target) ? new URL(target) : null;
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return false;
  try {
    await assertPublicHttpUrl(target);
    return true;
  } catch {
    return false;
  }
}

async function ownedSetting(id: string, userId: string): Promise<SettingRow | null> {
  return prisma.notificationSetting.findUnique({ where: { id, userId } });
}

async function listChannels(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const settings = await prisma.notificationSetting.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  const channels = await Promise.all(
    settings.map(async (setting) =>
      channelResponse(
        setting,
        await prisma.notificationDelivery.findFirst({
          where: { settingId: setting.id },
          orderBy: { createdAt: 'desc' },
        }),
      ),
    ),
  );
  return reply.send({ channels });
}

async function createChannel(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const body = parseOrReply(channelBodySchema, request.body, reply, 'Invalid channel', {
    includeIssues: true,
    request,
  });
  if (!body) return;
  if (!(await targetValid(body.channel, body.target))) {
    return reply.status(400).send({ error: 'Invalid target for the channel type' });
  }
  const setting = await prisma.notificationSetting.create({
    data: {
      userId,
      channel: body.channel,
      target: body.target,
      events: body.events,
      enabled: body.enabled ?? true,
      secretEnc: body.channel === 'webhook' ? encrypt(generateWebhookSecret()) : null,
    },
  });
  return reply.status(201).send({ channel: channelResponse(setting) });
}

async function updateChannel(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid channel id');
  if (!params) return;
  const body = parseOrReply(channelPatchSchema, request.body, reply, 'Invalid channel update', {
    includeIssues: true,
    request,
  });
  if (!body) return;
  const current = await ownedSetting(params.id, userId);
  if (!current) return reply.status(404).send({ error: 'Channel not found' });
  if (body.target !== undefined && !(await targetValid(current.channel, body.target))) {
    return reply.status(400).send({ error: 'Invalid target for the channel type' });
  }
  const setting = await prisma.notificationSetting.update({
    where: { id: current.id },
    data: {
      ...(body.target !== undefined ? { target: body.target } : {}),
      ...(body.events !== undefined ? { events: body.events } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    },
  });
  return reply.send({ channel: channelResponse(setting) });
}

async function deleteChannel(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid channel id');
  if (!params) return;
  const { count } = await prisma.notificationSetting.deleteMany({
    where: { id: params.id, userId },
  });
  return reply.send({ deleted: count });
}

async function testChannel(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid channel id');
  if (!params) return;
  try {
    const result = await sendTestNotification(params.id, userId);
    if (!result) return reply.status(404).send({ error: 'Channel not found' });
    return reply.send(result);
  } catch (err) {
    return reply.send({ ok: false, statusCode: null, error: errorMessage(err) });
  }
}

async function listDeliveries(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid channel id');
  if (!params) return;
  if (!(await ownedSetting(params.id, userId))) {
    return reply.status(404).send({ error: 'Channel not found' });
  }
  const deliveries = await prisma.notificationDelivery.findMany({
    where: { settingId: params.id },
    orderBy: { createdAt: 'desc' },
    take: DELIVERIES_TAKE,
  });
  return reply.send({ deliveries: deliveries.map(deliveryResponse) });
}

const notificationsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.get('/', listNotifications);
  app.post('/:id/read', markRead);
  app.post('/read-all', markAllRead);
  app.get('/channels', listChannels);
  app.post('/channels', { config: { rateLimit: SETTINGS_RATE_LIMIT } }, createChannel);
  app.patch('/channels/:id', { config: { rateLimit: SETTINGS_RATE_LIMIT } }, updateChannel);
  app.delete('/channels/:id', { config: { rateLimit: SETTINGS_RATE_LIMIT } }, deleteChannel);
  app.post('/channels/:id/test', { config: { rateLimit: SETTINGS_RATE_LIMIT } }, testChannel);
  app.get('/channels/:id/deliveries', listDeliveries);
};

export default notificationsRoutes;
