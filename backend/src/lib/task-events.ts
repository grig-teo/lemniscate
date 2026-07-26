import type { Prisma, TaskEventKind, TaskStatus } from '@prisma/client';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { prisma } from './prisma.js';

// Task events are persisted to Postgres (source of truth, replayable via the
// API) and then fan-out published to Redis so subscribers can stream them
// live. Channel naming: `task-events:<taskId>`.
//
// Pinned payload shapes:
//   log    { line: string }
//   status { status: TaskStatus }
//   diff   { path: string, diff: string } | { path: string, action: string }

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(config.REDIS_URL);
  }
  return publisher;
}

// Serializes a TaskEvent into the wire shape shared by the JSON endpoint,
// SSE replay, and Redis pub/sub messages. Single home — the tasks route
// serializes events through this same function.
export function serializeTaskEvent(event: {
  id: string;
  kind: string;
  payload: unknown;
  createdAt: Date;
}) {
  return {
    id: event.id,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

export async function publishTaskEvent(
  taskId: string,
  kind: TaskEventKind,
  payload: object,
): Promise<void> {
  const event = await prisma.taskEvent.create({
    data: { taskId, kind, payload: payload as Prisma.InputJsonValue },
  });
  try {
    await getPublisher().publish(`task-events:${taskId}`, JSON.stringify(serializeTaskEvent(event)));
  } catch (err) {
    // The DB row is the source of truth; a dropped live update is not fatal.
    console.error(`failed to publish task event to Redis (task ${taskId}):`, err);
  }
  await enforceEventCap(taskId).catch((err) => {
    console.error(`failed to enforce event cap (task ${taskId}):`, err);
  });
}

// Sentinel log line shown at the top of truncated history so the user knows
// earlier output was pruned. Persisted as a regular TaskEvent so it appears in
// both the JSON history and the SSE replay.
const TRUNCATION_MARKER_LINE = '— earlier output truncated —';

// Deletes events beyond TASK_EVENT_MAX_PER_TASK, keeping only the newest K.
// When rows are pruned, ensures a single truncation marker survives.
async function enforceEventCap(taskId: string): Promise<void> {
  const count = await prisma.taskEvent.count({ where: { taskId } });
  if (count <= config.TASK_EVENT_MAX_PER_TASK) return;

  const boundary = await prisma.taskEvent.findFirst({
    where: { taskId },
    orderBy: { createdAt: 'desc' },
    skip: config.TASK_EVENT_MAX_PER_TASK - 1,
    select: { createdAt: true },
  });
  if (!boundary) return;

  const deleted = await prisma.taskEvent.deleteMany({
    where: { taskId, createdAt: { lt: boundary.createdAt } },
  });
  if (deleted.count > 0) await ensureTruncationMarker(taskId);
}

// Creates the truncation marker only if one does not already exist for the
// task, then publishes it so live console subscribers see it immediately.
async function ensureTruncationMarker(taskId: string): Promise<void> {
  const existing = await prisma.taskEvent.findFirst({
    where: {
      taskId,
      kind: 'log',
      payload: { path: ['line'], equals: TRUNCATION_MARKER_LINE },
    },
    select: { id: true },
  });
  if (existing) return;

  const marker = await prisma.taskEvent.create({
    data: {
      taskId,
      kind: 'log',
      payload: { line: TRUNCATION_MARKER_LINE } as Prisma.InputJsonValue,
    },
  });
  try {
    await getPublisher().publish(
      `task-events:${taskId}`,
      JSON.stringify(serializeTaskEvent(marker)),
    );
  } catch (err) {
    console.error(`failed to publish truncation marker (task ${taskId}):`, err);
  }
}

// Updates the task status (plus optional extra columns) and emits the
// matching status event.
export async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
  extra: { error?: string | null; prUrl?: string | null; branchName?: string | null } = {},
): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status,
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.prUrl !== undefined ? { prUrl: extra.prUrl } : {}),
      ...(extra.branchName !== undefined ? { branchName: extra.branchName } : {}),
    },
  });
  await publishTaskEvent(taskId, 'status', { status });
}
