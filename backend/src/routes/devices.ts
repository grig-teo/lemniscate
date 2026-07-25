import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { deviceHub } from '../lib/device-hub.js';
import { generateDeviceToken, generatePairingCode, hashDeviceToken } from '../lib/device-tokens.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// Device pairing + reverse-tunnel gateway. The companion agent on each
// device claims a short-lived pairing code (POST /claim, public — the code
// is the credential) for a device token, then connects OUTBOUND to
// GET /ws?token=... and keeps that socket open; the server pushes
// DeviceCommands (run_web, …) through it. Register with prefix
// `/api/devices` (done in main.ts).

const PAIRING_TTL_MS = 10 * 60 * 1000;
const CLAIM_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;
const HEARTBEAT_WRITE_MS = 20_000;
const RECENT_COMMANDS_LIMIT = 20;

const claimBodySchema = z.object({
  code: z.string().length(6),
  name: z.string().min(1).max(80),
  platform: z.enum(['android', 'ios', 'desktop', 'web']),
  meta: z.record(z.unknown()).optional(),
});

const idParamSchema = z.object({ id: z.string().min(1).max(100) });

const renameBodySchema = z.object({ name: z.string().min(1).max(80) });

const commandBodySchema = z.object({
  type: z.literal('run_web'),
  payload: z.object({
    repoUrl: z.string().url(),
    branch: z.string().min(1).max(200),
    port: z.number().int().min(1).max(65535),
    composePath: z.string().min(1).max(500).optional(),
  }),
});

// tokenHash is never selected — the token is shown once at claim time.
const deviceSelect = {
  id: true,
  name: true,
  platform: true,
  meta: true,
  lastSeenAt: true,
  createdAt: true,
} satisfies Prisma.DeviceSelect;

// --- Pairing / claim ------------------------------------------------------

async function createPairing(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  await prisma.devicePairing.deleteMany({ where: { userId } });
  const pairing = await prisma.devicePairing.create({
    data: { code: generatePairingCode(), userId, expiresAt: new Date(Date.now() + PAIRING_TTL_MS) },
  });
  return reply.code(201).send({ code: pairing.code, expiresAt: pairing.expiresAt });
}

async function claimPairing(request: FastifyRequest, reply: FastifyReply) {
  const body = parseOrReply(claimBodySchema, request.body, reply, 'Invalid body', { request });
  if (body === null) return;
  const pairing = await prisma.devicePairing.findUnique({ where: { code: body.code } });
  if (!pairing) return reply.code(404).send({ error: 'Invalid pairing code' });
  if (pairing.expiresAt < new Date()) {
    return reply.code(401).send({ error: 'Pairing code expired' });
  }
  const deviceToken = generateDeviceToken();
  const device = await prisma.device.create({
    data: {
      userId: pairing.userId,
      name: body.name,
      platform: body.platform,
      meta: (body.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      tokenHash: hashDeviceToken(deviceToken),
    },
  });
  await prisma.devicePairing.delete({ where: { id: pairing.id } });
  return reply.code(201).send({ deviceId: device.id, deviceToken });
}

// --- Device management ----------------------------------------------------

// Loads the device when it belongs to the requester; sends 404 (existence
// of other users' devices must not leak) and returns null otherwise.
async function ownedDevice(request: FastifyRequest, reply: FastifyReply, id: string) {
  const device = await prisma.device.findFirst({
    where: { id, userId: authenticatedUserId(request) },
  });
  if (!device) {
    await reply.code(404).send({ error: 'Device not found' });
    return null;
  }
  return device;
}

async function listDevices(request: FastifyRequest) {
  const devices = await prisma.device.findMany({
    where: { userId: authenticatedUserId(request) },
    select: deviceSelect,
    orderBy: { createdAt: 'asc' },
  });
  return { devices: devices.map((device) => ({ ...device, online: deviceHub.isOnline(device.id) })) };
}

async function renameDevice(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid device id');
  if (params === null) return;
  const body = parseOrReply(renameBodySchema, request.body, reply, 'Invalid body', { request });
  if (body === null) return;
  if (!(await ownedDevice(request, reply, params.id))) return;
  const device = await prisma.device.update({
    where: { id: params.id },
    data: { name: body.name },
    select: deviceSelect,
  });
  return { device };
}

async function deleteDevice(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid device id');
  if (params === null) return;
  if (!(await ownedDevice(request, reply, params.id))) return;
  deviceHub.close(params.id);
  await prisma.device.delete({ where: { id: params.id } });
  return { deleted: true };
}

// --- Commands -------------------------------------------------------------

// Pushes the command to the connected agent and marks it sent; false when
// the device is offline (command then stays 'queued' until the WS flush).
async function dispatchCommand(command: {
  id: string;
  deviceId: string;
  type: string;
  payload: unknown;
}): Promise<boolean> {
  const sent = deviceHub.sendCommand(command.deviceId, {
    id: command.id,
    type: command.type,
    payload: command.payload,
  });
  if (!sent) return false;
  await prisma.deviceCommand.update({ where: { id: command.id }, data: { status: 'sent' } });
  return true;
}

async function listCommands(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid device id');
  if (params === null) return;
  if (!(await ownedDevice(request, reply, params.id))) return;
  const commands = await prisma.deviceCommand.findMany({
    where: { deviceId: params.id },
    orderBy: { createdAt: 'desc' },
    take: RECENT_COMMANDS_LIMIT,
  });
  return { commands };
}

async function createCommand(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid device id');
  if (params === null) return;
  const body = parseOrReply(commandBodySchema, request.body, reply, 'Invalid body', { request });
  if (body === null) return;
  if (!(await ownedDevice(request, reply, params.id))) return;
  const command = await prisma.deviceCommand.create({
    data: { deviceId: params.id, type: body.type, payload: body.payload },
  });
  const sent = await dispatchCommand(command);
  return reply.code(201).send({ command: { ...command, status: sent ? 'sent' : command.status } });
}

// --- WebSocket gateway ----------------------------------------------------

const agentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), meta: z.record(z.unknown()).optional() }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({
    type: z.literal('command_result'),
    id: z.string().min(1).max(100),
    status: z.enum(['running', 'done', 'failed']),
    result: z.unknown().optional(),
  }),
]);

export type AgentMessage = z.infer<typeof agentMessageSchema>;

/** Parses one raw agent frame; null when not valid JSON or not a known message. */
export function parseAgentMessage(raw: string): AgentMessage | null {
  try {
    const parsed = agentMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Merges agent-reported capabilities into Device.meta (read-modify-write;
// Prisma Json updates replace the whole value otherwise).
async function mergeDeviceMeta(deviceId: string, meta: Record<string, unknown>): Promise<void> {
  const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { meta: true } });
  const merged = { ...((device?.meta ?? {}) as Record<string, unknown>), ...meta };
  await prisma.device.update({
    where: { id: deviceId },
    data: { meta: merged as Prisma.InputJsonValue },
  });
}

/**
 * Applies one validated agent message. `touch` updates Device.lastSeenAt —
 * the caller picks the throttled variant for heartbeats.
 */
export async function handleAgentMessage(
  deviceId: string,
  message: AgentMessage,
  touch: () => Promise<void>,
): Promise<void> {
  if (message.type === 'heartbeat') {
    await touch();
    return;
  }
  if (message.type === 'hello') {
    if (message.meta) await mergeDeviceMeta(deviceId, message.meta);
    await touch();
    return;
  }
  await prisma.deviceCommand.updateMany({
    where: { id: message.id, deviceId },
    data: { status: message.status, result: message.result as Prisma.InputJsonValue },
  });
}

// lastSeenAt writer: heartbeats throttle DB writes to one per 20s.
function createLastSeenTouch(deviceId: string) {
  let lastWrite = 0;
  const force = async () => {
    lastWrite = Date.now();
    await prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
  };
  const due = async () => {
    if (Date.now() - lastWrite > HEARTBEAT_WRITE_MS) await force();
  };
  return { force, due };
}

// Sends any commands queued while the device was offline, oldest first.
async function flushQueuedCommands(deviceId: string): Promise<void> {
  const queued = await prisma.deviceCommand.findMany({
    where: { deviceId, status: 'queued' },
    orderBy: { createdAt: 'asc' },
  });
  for (const command of queued) {
    await dispatchCommand(command);
  }
}

async function onSocketMessage(
  deviceId: string,
  raw: Buffer,
  touch: ReturnType<typeof createLastSeenTouch>,
): Promise<void> {
  const message = parseAgentMessage(raw.toString());
  if (!message) return;
  await handleAgentMessage(deviceId, message, message.type === 'heartbeat' ? touch.due : touch.force);
}

async function handleDeviceSocket(socket: WebSocket, request: FastifyRequest): Promise<void> {
  const token = (request.query as { token?: string }).token;
  const device = token
    ? await prisma.device.findUnique({ where: { tokenHash: hashDeviceToken(token) } })
    : null;
  if (!device) {
    socket.close(4001, 'invalid device token');
    return;
  }
  deviceHub.register(device.id, socket);
  const touch = createLastSeenTouch(device.id);
  await touch.force();
  socket.send(JSON.stringify({ type: 'welcome', deviceId: device.id }));
  await flushQueuedCommands(device.id);
  socket.on('message', (raw: Buffer) => void onSocketMessage(device.id, raw, touch));
  socket.on('close', () => {
    deviceHub.unregister(device.id, socket);
    void touch.force();
  });
}

export default async function devicesRoutes(app: FastifyInstance) {
  app.post('/pairings', { preHandler: requireAuth }, createPairing);
  app.post('/claim', { config: { rateLimit: CLAIM_RATE_LIMIT } }, claimPairing);
  app.get('/', { preHandler: requireAuth }, listDevices);
  app.patch('/:id', { preHandler: requireAuth }, renameDevice);
  app.delete('/:id', { preHandler: requireAuth }, deleteDevice);
  app.get('/:id/commands', { preHandler: requireAuth }, listCommands);
  app.post('/:id/commands', { preHandler: requireAuth }, createCommand);
  app.get('/ws', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    void handleDeviceSocket(socket, request);
  });
}
