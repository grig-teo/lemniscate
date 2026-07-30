import type { Prisma, TaskEventKind, TaskStatus } from '@prisma/client';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

// Task events are persisted to Postgres (source of truth, replayable via the
// API) and then fan-out published to Redis so subscribers can stream them
// live. Channel naming: `task-events:<taskId>`.
//
// Pinned payload shapes:
//   log    { line: string } | { lines: string[] }   (batched lines; frontend
//          normalizes both via payloadToLogText in lib/event-payload.ts)
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

// Cap enforcement runs at most once every CAP_CHECK_INTERVAL publishes per
// task instead of on every write. The table may briefly exceed K by up to
// CAP_CHECK_INTERVAL rows between checks — acceptable since K is 5,000 and
// the expensive prune cycle (COUNT + findMany + deleteMany) would otherwise
// add a round-trip to every single event write.
export const TASK_EVENT_CAP_CHECK_INTERVAL = 50;
const capCounters = new Map<string, number>();

/** Reset the per-task cap counters (test helper). */
export function resetCapCounters(): void {
  capCounters.clear();
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
    logger.error({ taskId, err }, 'failed to publish task event to Redis');
  }
  await maybeEnforceEventCap(taskId);
}

async function maybeEnforceEventCap(taskId: string): Promise<void> {
  const n = (capCounters.get(taskId) ?? 0) + 1;
  if (n % TASK_EVENT_CAP_CHECK_INTERVAL !== 0) {
    capCounters.set(taskId, n);
    return;
  }
  capCounters.set(taskId, 0);
  await enforceEventCap(taskId).catch((err) => {
    logger.error({ taskId, err }, 'failed to enforce event cap');
  });
}

// Sentinel log line shown at the top of truncated history so the user knows
// earlier output was pruned. Persisted as a regular TaskEvent so it appears in
// both the JSON history and the SSE replay.
const TRUNCATION_MARKER_LINE = '— earlier output truncated —';

// Deletes events beyond TASK_EVENT_MAX_PER_TASK, keeping the newest K-1 rows
// plus one truncation marker (total = K). Reserving K-1 (not K) survivor
// slots means the marker fits within the cap instead of pushing the count to
// K+1, which would immediately re-trigger enforcement on the next publish.
// Uses id-based deletion (not timestamp comparison) so events sharing the
// boundary timestamp are correctly pruned regardless of ties.
async function enforceEventCap(taskId: string): Promise<void> {
  const count = await prisma.taskEvent.count({ where: { taskId } });
  if (count <= config.TASK_EVENT_MAX_PER_TASK) return;

  const survivors = await newestSurvivorIds(taskId);
  const deleted = await prisma.taskEvent.deleteMany({
    where: { taskId, id: { notIn: survivors } },
  });
  if (deleted.count > 0) await ensureTruncationMarker(taskId);
}

// Ids of the K-1 newest events for a task. Ordered by createdAt desc then id
// desc so timestamp ties are broken deterministically. One slot is reserved
// for the truncation marker so the total stays within K.
async function newestSurvivorIds(taskId: string): Promise<string[]> {
  const events = await prisma.taskEvent.findMany({
    where: { taskId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: config.TASK_EVENT_MAX_PER_TASK - 1,
    select: { id: true },
  });
  return events.map((e) => e.id);
}

// Creates the truncation marker only if one does not already exist for the
// task. The check-and-create runs inside a transaction with a per-task
// advisory lock so two concurrent publishTaskEvent calls (e.g. stdout and
// stderr batchers flushing near-simultaneously) cannot both insert a marker.
async function ensureTruncationMarker(taskId: string): Promise<void> {
  const marker = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${taskId}))`;
    const existing = await tx.taskEvent.findFirst({
      where: {
        taskId,
        kind: 'log',
        payload: { path: ['line'], equals: TRUNCATION_MARKER_LINE },
      },
      select: { id: true },
    });
    if (existing) return null;
    return tx.taskEvent.create({
      data: {
        taskId,
        kind: 'log',
        payload: { line: TRUNCATION_MARKER_LINE } as Prisma.InputJsonValue,
      },
    });
  });
  if (!marker) return;
  try {
    await getPublisher().publish(
      `task-events:${taskId}`,
      JSON.stringify(serializeTaskEvent(marker)),
    );
  } catch (err) {
    logger.error({ taskId, err }, 'failed to publish truncation marker');
  }
}

// Updates the task status (plus optional extra columns) and emits the
// matching status event. The errorCode is included in the event payload so
// the frontend can render the ErrorBanner immediately on the SSE update.
//
// Session anchoring: one pipeline pass (run → review → merge gate) is ONE
// session. sessionStartedAt is (re)set when the task enters an active status
// from an idle/terminal one — a rerun after failed/done or a first start
// begins a new session, while run → reviewing_code keeps the existing one.
// The console elapsed timer anchors here, not at createdAt.
const ACTIVE_SESSION_STATUSES: ReadonlySet<TaskStatus> = new Set(['running', 'reviewing_code']);
const IDLE_SESSION_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'pending',
  'queued',
  'failed',
  'done',
  'closed',
]);

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
  const current = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, sessionStartedAt: true },
  });
  const startsSession =
    ACTIVE_SESSION_STATUSES.has(status) &&
    current !== null &&
    (current.sessionStartedAt === null || IDLE_SESSION_STATUSES.has(current.status));
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status,
      ...(startsSession ? { sessionStartedAt: new Date() } : {}),
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
