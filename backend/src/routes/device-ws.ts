import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import type { WebSocket } from 'ws';
import { config } from '../config.js';
import { artifactDownloadPath } from '../lib/device-artifacts.js';
import { nextCommandAfterBuild } from '../lib/device-commands.js';
import { dispatchCommand } from '../lib/device-dispatch.js';
import { deviceHub } from '../lib/device-hub.js';
import { prisma } from '../lib/prisma.js';
import { deviceByToken } from './device-handlers.js';
import { parseAgentMessage, type AgentMessage } from './device-schemas.js';

// WebSocket gateway: the companion agent connects OUTBOUND to
// GET /ws?token=... and keeps the socket open; the server pushes
// DeviceCommands (run_web, …) through it and applies the agent's
// hello/heartbeat/capabilities/command_result frames here.

const HEARTBEAT_WRITE_MS = 20_000;

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
        payload: {
          apkUrl,
          appName: next.appName,
          ...(next.deviceSerial ? { deviceSerial: next.deviceSerial } : {}),
        },
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

export async function handleDeviceSocket(socket: WebSocket, request: FastifyRequest): Promise<void> {
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
