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
