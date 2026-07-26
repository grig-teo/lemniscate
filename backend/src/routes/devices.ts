import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { artifactDownloadPath, deviceArtifactStream, storeDeviceArtifact } from '../lib/device-artifacts.js';
import { nextCommandAfterBuild } from '../lib/device-commands.js';
import { config } from '../config.js';
import { dispatchCommand } from '../lib/device-dispatch.js';
import { deviceHub } from '../lib/device-hub.js';
import {
  deviceTokenFromHeader,
  generateDeviceToken,
  generatePairingCode,
  hashDeviceToken,
} from '../lib/device-tokens.js';
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
const ARTIFACT_BODY_LIMIT = 200 * 1024 * 1024;

// Gradle module/task names land inside a `sh -c` script on the builder —
// keep them strictly alphanumeric so no shell injection is possible.
const gradleName = z.string().regex(/^[a-zA-Z0-9_-]+$/);

const claimBodySchema = z.object({
  code: z.string().length(6),
  name: z.string().min(1).max(80),
  platform: z.enum(['android', 'ios', 'desktop', 'web']),
  meta: z.record(z.unknown()).optional(),
});

const idParamSchema = z.object({ id: z.string().min(1).max(100) });

const renameBodySchema = z.object({ name: z.string().min(1).max(80) });

const commandBodySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_web'),
    payload: z.object({
      repoUrl: z.string().url(),
      branch: z.string().min(1).max(200),
      port: z.number().int().min(1).max(65535),
      composePath: z.string().min(1).max(500).optional(),
    }),
  }),
  z.object({
    type: z.literal('install_apk'),
    payload: z.object({
      apkUrl: z.string().url(),
      appName: z.string().min(1).max(120).optional(),
    }),
  }),
  // User-facing part of a build request; the server adds gradle/docker
  // defaults and uploadBaseUrl at dispatch (lib/device-dispatch.ts), and the
  // install chaining fields via POST /api/repositories/:id/deploy-android.
  z.object({
    type: z.literal('build_android'),
    payload: z.object({
      repoUrl: z.string().url(),
      branch: z.string().min(1).max(200),
      gradleTask: gradleName.optional(),
      gradleModule: gradleName.optional(),
      image: z.string().min(1).max(200).optional(),
    }),
  }),
  // startScript lands inside an `npm run <script>` spawn on the device —
  // keep it strictly alphanumeric (plus npm's : _ - conventions).
  z.object({
    type: z.literal('run_desktop'),
    payload: z.object({
      repoUrl: z.string().url(),
      branch: z.string().min(1).max(200),
      startScript: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-zA-Z0-9:_-]+$/)
        .optional(),
    }),
  }),
  // scheme/destination are passed to xcodebuild on a macOS agent; both
  // optional — the agent auto-detects when omitted.
  z.object({
    type: z.literal('run_ios'),
    payload: z.object({
      repoUrl: z.string().url(),
      branch: z.string().min(1).max(200),
      scheme: z.string().min(1).max(200).optional(),
      destination: z.string().min(1).max(200).optional(),
    }),
  }),
]);

// Optional link back to the task whose result the command runs.
const createCommandBodySchema = commandBodySchema.and(
  z.object({ taskId: z.string().min(1).max(100).optional() }),
);

// install_apk launches an install intent on Android; on desktop the agent
// only downloads the file. iOS/web devices cannot receive APKs at all.
const INSTALL_APK_PLATFORMS = new Set(['android', 'desktop']);

function installApkBlock(platform: string): string | null {
  if (INSTALL_APK_PLATFORMS.has(platform)) return null;
  return `install_apk is only available on android and desktop devices (this device is ${platform})`;
}

// run_desktop spawns a GUI app via npm on the machine itself — only
// desktop agents can do that.
function runDesktopBlock(platform: string): string | null {
  if (platform === 'desktop') return null;
  return `run_desktop is only available on desktop devices (this device is ${platform})`;
}

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

// The device behind a raw token (WS query param or Authorization header).
function deviceByToken(token: string | null | undefined) {
  return token ? prisma.device.findUnique({ where: { tokenHash: hashDeviceToken(token) } }) : null;
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
  const body = parseOrReply(createCommandBodySchema, request.body, reply, 'Invalid body', {
    request,
  });
  if (body === null) return;
  const device = await ownedDevice(request, reply, params.id);
  if (!device) return;
  if (body.type === 'install_apk') {
    const block = installApkBlock(device.platform);
    if (block) return reply.code(400).send({ error: block });
  }
  if (body.type === 'run_desktop') {
    const block = runDesktopBlock(device.platform);
    if (block) return reply.code(400).send({ error: block });
  }
  const command = await prisma.deviceCommand.create({
    data: { deviceId: params.id, type: body.type, payload: body.payload, taskId: body.taskId },
  });
  const sent = await dispatchCommand(command);
  return reply.code(201).send({ command: { ...command, status: sent ? 'sent' : command.status } });
}

// --- Artifact upload (builder agents) --------------------------------------

// POST /artifacts?filename=app.apk — the builder agent uploads the APK it
// produced, authenticating with its own device token
// (`Authorization: Device <token>`); the raw token is never stored server-side.
async function uploadArtifact(request: FastifyRequest, reply: FastifyReply) {
  const device = await deviceByToken(deviceTokenFromHeader(request.headers.authorization));
  if (!device) return reply.code(401).send({ error: 'Invalid device token' });
  const filename = (request.query as { filename?: string }).filename ?? 'app.apk';
  const body = request.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return reply.code(400).send({ error: 'Expected an octet-stream body' });
  }
  try {
    return reply.code(201).send(await storeDeviceArtifact(device.id, filename, body));
  } catch (err) {
    request.log.error({ err }, 'artifact upload failed');
    return reply.code(503).send({ error: 'Artifact storage unavailable' });
  }
}

// GET /artifacts/* — install-target agents download the built APK through
// the backend (MinIO's own endpoint is internal-only). Same device-token
// auth as uploads; keys are scoped to the builder's device id.
async function downloadArtifact(request: FastifyRequest, reply: FastifyReply) {
  const device = await deviceByToken(deviceTokenFromHeader(request.headers.authorization));
  if (!device) return reply.code(401).send({ error: 'Invalid device token' });
  const key = (request.params as { '*': string })['*'];
  if (!key || key.includes('..')) return reply.code(400).send({ error: 'Invalid artifact key' });
  const artifact = await deviceArtifactStream(key);
  if (!artifact) return reply.code(404).send({ error: 'Artifact not found' });
  return reply
    .header('Content-Type', 'application/vnd.android.package-archive')
    .header('Content-Length', artifact.size)
    .send(artifact.stream);
}

// --- WebSocket gateway ----------------------------------------------------

// Live environment report from the agent: docker plus the run targets it can
// see (adb devices, iOS devices/simulators, Android emulators). Lists default
// empty so a minimal report still parses; unknown fields are stripped.
const capabilitiesSchema = z.object({
  dockerAvailable: z.boolean().default(false),
  androidDevices: z
    .array(
      z.object({
        serial: z.string().min(1).max(200),
        model: z.string().max(200).optional(),
        transport: z.enum(['usb', 'wifi']),
      }),
    )
    .max(50)
    .default([]),
  iosDevices: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        udid: z.string().min(1).max(200),
        available: z.boolean(),
      }),
    )
    .max(50)
    .default([]),
  simulators: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        runtime: z.string().max(200).optional(),
        state: z.string().max(50).optional(),
      }),
    )
    .max(100)
    .default([]),
  emulators: z.array(z.object({ name: z.string().min(1).max(200) })).max(100).default([]),
});

const agentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), meta: z.record(z.unknown()).optional() }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('capabilities'), capabilities: capabilitiesSchema }),
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

// A finished build_android chains into install_apk for the target device.
// The APK downloads THROUGH the backend (internal MinIO URLs would be
// unreachable from the device); the target agent authenticates with its own
// device token. Storage failures must not break result handling — the build
// itself stays 'done'.
async function chainInstallAfterBuild(
  deviceId: string,
  commandId: string,
  result: unknown,
): Promise<void> {
  const command = await prisma.deviceCommand.findFirst({ where: { id: commandId, deviceId } });
  const next = command ? nextCommandAfterBuild(command, result) : null;
  if (!next) return;
  try {
    const apkUrl = `${config.BACKEND_URL}${artifactDownloadPath(next.artifactKey)}`;
    const install = await prisma.deviceCommand.create({
      data: {
        deviceId: next.installDeviceId,
        type: 'install_apk',
        payload: { apkUrl, appName: next.appName },
      },
    });
    await dispatchCommand(install);
  } catch (err) {
    console.error(`build→install chaining failed for command ${commandId}:`, err);
  }
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
  if (message.type === 'capabilities') {
    // Latest report replaces the old one wholesale — a disappeared device
    // must not linger in meta.environment.
    await mergeDeviceMeta(deviceId, { environment: message.capabilities });
    await touch();
    return;
  }
  await prisma.deviceCommand.updateMany({
    where: { id: message.id, deviceId },
    data: { status: message.status, result: message.result as Prisma.InputJsonValue },
  });
  if (message.status === 'done') {
    await chainInstallAfterBuild(deviceId, message.id, message.result);
  }
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
  const device = await deviceByToken((request.query as { token?: string }).token);
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
  // APK uploads from builder agents: raw bytes, capped at 200MB.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: ARTIFACT_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );
  app.post('/pairings', { preHandler: requireAuth }, createPairing);
  app.post('/claim', { config: { rateLimit: CLAIM_RATE_LIMIT } }, claimPairing);
  app.post('/artifacts', uploadArtifact);
  app.get('/artifacts/*', downloadArtifact);
  app.get('/', { preHandler: requireAuth }, listDevices);
  app.patch('/:id', { preHandler: requireAuth }, renameDevice);
  app.delete('/:id', { preHandler: requireAuth }, deleteDevice);
  app.get('/:id/commands', { preHandler: requireAuth }, listCommands);
  app.post('/:id/commands', { preHandler: requireAuth }, createCommand);
  app.get('/ws', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    void handleDeviceSocket(socket, request);
  });
}
