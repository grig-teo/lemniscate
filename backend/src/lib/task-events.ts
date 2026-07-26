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
  // Best-effort cap enforcement — non-fatal if it fails.
  void enforceEventCap(taskId).catch(() => {});
}

// --- TaskEvent cap enforcement ---
//
// TaskEvent rows grow with every agent stdout/stderr line. Without a cap a
// long-running task can produce tens of thousands of rows, bloating the table
// and slowing the events replay. The cap keeps at most
// config.TASK_EVENT_MAX_PER_TASK rows per task: a modulo counter avoids
// COUNT(*) on every write, and when the cap is exceeded the oldest events are
// deleted under an advisory lock with a boundary marker.

// Run the COUNT(*) + truncate check on every Nth event for this task, using a
// Redis INCR counter. Falls back to always-checking when Redis is unavailable
// so correctness never depends on Redis.
const CAP_CHECK_EVERY = 64;

function eventCounterKey(taskId: string): string {
  return `task-event-count:${taskId}`;
}

async function shouldCheckCap(taskId: string): Promise<boolean> {
  try {
    const n = await getPublisher().incr(eventCounterKey(taskId));
    return n % CAP_CHECK_EVERY === 0;
  } catch {
    return true;
  }
}

// Counts events for the task and truncates when the cap is exceeded.
// Exported for direct unit testing.
export async function enforceEventCap(taskId: string): Promise<void> {
  if (!(await shouldCheckCap(taskId))) return;
  const count = await prisma.taskEvent.count({ where: { taskId } });
  if (count <= config.TASK_EVENT_MAX_PER_TASK) return;
  await truncateTaskEvents(taskId, config.TASK_EVENT_MAX_PER_TASK);
}

// Deletes all but the newest `keep` events under a transaction-scoped advisory
// lock so two concurrent workers cannot both truncate and double-insert the
// marker. A single 'log' event with { truncated: true } marks the boundary.
async function truncateTaskEvents(taskId: string, keep: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${taskId}))`;
    const survivors = await tx.taskEvent.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: keep,
      select: { id: true },
    });
    await tx.taskEvent.deleteMany({
      where: { taskId, NOT: { id: { in: survivors.map((e) => e.id) } } },
    });
    await tx.taskEvent.create({
      data: {
        taskId,
        kind: 'log',
        payload: {
          truncated: true,
          message: 'Earlier events were truncated to bound table growth',
        } as Prisma.InputJsonValue,
      },
    });
  });
}

// Updates the task status (plus optional extra columns) and emits the
// matching status event. The errorCode is included in the event payload so
// the frontend can render the ErrorBanner immediately on the SSE update.
export async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
  extra: {
    error?: string | null;
    errorCode?: string | null;
    prUrl?: string | null;
    branchName?: string | null;
  } = {},
): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status,
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
      ...(extra.prUrl !== undefined ? { prUrl: extra.prUrl } : {}),
      ...(extra.branchName !== undefined ? { branchName: extra.branchName } : {}),
    },
  });
  await publishTaskEvent(taskId, 'status', {
    status,
    ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
  });
}
