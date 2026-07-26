import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  artifactOwnerDeviceId,
  checkArtifactQuota,
  deviceArtifactStream,
  storeDeviceArtifact,
} from '../lib/device-artifacts.js';
import { dispatchCommand } from '../lib/device-dispatch.js';
import { deviceHub } from '../lib/device-hub.js';
import {
  deviceTokenFromHeader,
  generateDeviceToken,
  generatePairingCode,
  hashDeviceToken,
} from '../lib/device-tokens.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import {
  claimBodySchema,
  createCommandBodySchema,
  deviceSelect,
  idParamSchema,
  installApkBlock,
  renameBodySchema,
  runDesktopBlock,
} from './device-schemas.js';

// Device REST handlers: pairing/claim, device management, command creation,
// and the artifact up/download endpoints used by builder agents.

const PAIRING_TTL_MS = 10 * 60 * 1000;
const RECENT_COMMANDS_LIMIT = 20;

// --- Pairing / claim ------------------------------------------------------

export async function createPairing(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  await prisma.devicePairing.deleteMany({ where: { userId } });
  const pairing = await prisma.devicePairing.create({
    data: { code: generatePairingCode(), userId, expiresAt: new Date(Date.now() + PAIRING_TTL_MS) },
  });
  return reply.code(201).send({ code: pairing.code, expiresAt: pairing.expiresAt });
}

export async function claimPairing(request: FastifyRequest, reply: FastifyReply) {
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

export async function listDevices(request: FastifyRequest) {
  const devices = await prisma.device.findMany({
    where: { userId: authenticatedUserId(request) },
    select: deviceSelect,
    orderBy: { createdAt: 'asc' },
  });
  return { devices: devices.map((device) => ({ ...device, online: deviceHub.isOnline(device.id) })) };
}

export async function renameDevice(request: FastifyRequest, reply: FastifyReply) {
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

export async function deleteDevice(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid device id');
  if (params === null) return;
  if (!(await ownedDevice(request, reply, params.id))) return;
  deviceHub.close(params.id);
  await prisma.device.delete({ where: { id: params.id } });
  return { deleted: true };
}

// --- Commands -------------------------------------------------------------

// The device behind a raw token (WS query param or Authorization header).
export function deviceByToken(token: string | null | undefined) {
  return token ? prisma.device.findUnique({ where: { tokenHash: hashDeviceToken(token) } }) : null;
}

export async function listCommands(request: FastifyRequest, reply: FastifyReply) {
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

export async function createCommand(request: FastifyRequest, reply: FastifyReply) {
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
// Uploads are capped at DEVICE_ARTIFACT_MAX_PER_DAY per rolling 24h (429
// beyond), and stored APKs expire after DEVICE_ARTIFACT_TTL_DAYS days — a
// re-install attempted after expiry gets a 404 and must rebuild.
export async function uploadArtifact(request: FastifyRequest, reply: FastifyReply) {
  const device = await deviceByToken(deviceTokenFromHeader(request.headers.authorization));
  if (!device) return reply.code(401).send({ error: 'Invalid device token' });
  if (!(await checkArtifactQuota(device.id))) {
    return reply.code(429).send({ error: 'Daily artifact upload quota exceeded' });
  }
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
// auth as uploads; keys are scoped to the builder's device id, and downloads
// are limited to devices of the SAME user as the key's owner (IDOR guard).
async function assertArtifactAccess(ownerDeviceId: string, userId: string): Promise<boolean> {
  const owner = await prisma.device.findUnique({ where: { id: ownerDeviceId } });
  return owner?.userId === userId;
}

export async function downloadArtifact(request: FastifyRequest, reply: FastifyReply) {
  const device = await deviceByToken(deviceTokenFromHeader(request.headers.authorization));
  if (!device) return reply.code(401).send({ error: 'Invalid device token' });
  const key = (request.params as { '*': string })['*'];
  const ownerDeviceId = key && !key.includes('..') ? artifactOwnerDeviceId(key) : null;
  if (!ownerDeviceId) return reply.code(400).send({ error: 'Invalid artifact key' });
  // 404 (not 403): cross-user artifact existence must not leak.
  if (!(await assertArtifactAccess(ownerDeviceId, device.userId))) {
    return reply.code(404).send({ error: 'Artifact not found' });
  }
  const artifact = await deviceArtifactStream(key);
  if (!artifact) return reply.code(404).send({ error: 'Artifact not found' });
  return reply
    .header('Content-Type', 'application/vnd.android.package-archive')
    .header('Content-Length', artifact.size)
    .send(artifact.stream);
}
