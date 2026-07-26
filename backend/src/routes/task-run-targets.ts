import type { FastifyReply, FastifyRequest } from 'fastify';
import { deviceHub } from '../lib/device-hub.js';
import { prisma } from '../lib/prisma.js';
import { detectRunTargets, type RunTarget } from '../lib/run-targets.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { ownedTaskWhere } from './task-lifecycle.js';
import { idParamsSchema } from './task-schemas.js';

// GET /tasks/:id/run-targets handler: the platforms the task's branch
// touched plus the user's devices able to run each.

// Run targets a finished task affected → the device command type that runs
// each of them (shared with routes/devices.ts command creation).
export const RUN_TARGET_COMMAND_TYPES = {
  android: 'build_android',
  ios: 'run_ios',
  web: 'run_web',
  desktop: 'run_desktop',
} as const satisfies Record<RunTarget, string>;

// A device counts as online when it has a live hub connection or a recent
// lastSeenAt (the WS heartbeat touches it every ~20s).
const DEVICE_ONLINE_WINDOW_MS = 90_000;

// Targets with no matching device are still returned (empty devices array)
// so the UI can grey them out.
export async function getTaskRunTargets(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: { changedPaths: true, repository: { select: { platform: true } } },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }
  const changedPaths = Array.isArray(task.changedPaths)
    ? task.changedPaths.filter((p): p is string => typeof p === 'string')
    : null;
  const targets = detectRunTargets(changedPaths, task.repository.platform);

  const devices = await prisma.device.findMany({
    where: { userId },
    select: { id: true, name: true, platform: true, meta: true, lastSeenAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const now = Date.now();
  const online = (device: (typeof devices)[number]): boolean =>
    deviceHub.isOnline(device.id) ||
    (device.lastSeenAt !== null && now - device.lastSeenAt.getTime() < DEVICE_ONLINE_WINDOW_MS);
  const dockerAvailable = (device: (typeof devices)[number]): boolean =>
    (device.meta as Record<string, unknown> | null)?.dockerAvailable === true;

  return {
    targets: targets.map((target) => ({
      target,
      commandType: RUN_TARGET_COMMAND_TYPES[target],
      // web runs via docker compose, so it needs a docker-capable agent; the
      // other targets are best-effort on any of the user's devices.
      devices: devices
        .filter((device) => (target === 'web' ? dockerAvailable(device) : true))
        .map((device) => ({
          id: device.id,
          name: device.name,
          platform: device.platform,
          online: online(device),
          meta: device.meta,
        })),
    })),
  };
}
