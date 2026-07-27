import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { serializeTaskEvent } from '../lib/task-events.js';
import { sseHub } from '../lib/sse-hub.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { ownedTaskWhere, wantsSse } from './task-lifecycle.js';
import { idParamsSchema } from './task-schemas.js';

// Task events handler + SSE stream. Event contract (shared with the worker,
// implemented in src/lib/task-events.ts): Redis pub/sub channel
// `task-events:<taskId>`, message JSON {id, kind, payload, createdAt} with
// createdAt as an ISO string. Payloads:
//   log    → { line: string } | { lines: string[] }
//   status → { status: 'pending'|'queued'|'running'|'reviewing_code'|'awaiting_review'|'done'|'failed'|'closed' }
//   diff   → { path: string, diff: string } | { path: string, action: 'created'|'modified'|'deleted' }
//
// Live events are delivered through a shared SSE multiplexer (sseHub) that
// uses a single Redis psubscribe connection for all viewers, rather than one
// Redis connection per browser tab. The hub also enforces a per-user
// concurrent-stream cap (SSE_MAX_PER_USER) and an idle-timeout safety close.

// Maximum events returned in a single JSON or SSE-replay response. Bounds
// response size and latency regardless of how many events a task accumulated.
const HISTORY_TAKE = 1_000;

// Task events: full history as JSON when the client asks for it,
// otherwise a live SSE stream (history replay + pub/sub follow).
export async function getTaskEvents(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: { id: true },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }

  if (!wantsSse(request.headers.accept)) {
    // Query newest N then reverse so the payload is chronological but the
    // response size is bounded regardless of task age.
    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TAKE,
    });
    return events.reverse().map(serializeTaskEvent);
  }

  return streamTaskEvents(request, reply, task.id, userId);
}

// Replay the most recent N persisted events (descending query, reversed so
// they are written in chronological order), then follow live events.
async function replayHistory(reply: FastifyReply, taskId: string): Promise<void> {
  const history = await prisma.taskEvent.findMany({
    where: { taskId },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_TAKE,
  });
  for (const event of history.reverse()) {
    reply.raw.write(`data: ${JSON.stringify(serializeTaskEvent(event))}\n\n`);
  }
}

// Registers the response with the shared SSE hub (which holds a single Redis
// psubscribe connection for all viewers), then replays history. Heartbeats
// and idle-timeout cleanup are handled by the hub's sweep timer.
async function streamTaskEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  taskId: string,
  userId: string,
): Promise<void> {
  // Per-user cap must be checked (and the response registered) BEFORE
  // hijacking — a rejected stream returns a normal HTTP 429.
  if (!sseHub.register(taskId, userId, reply.raw)) {
    return reply.code(429).send({ error: 'Too many concurrent event streams' });
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // Attach the cleanup handler before the first await so a disconnect during
  // history replay is caught immediately.
  request.raw.on('close', () => sseHub.unregister(taskId, reply.raw));

  await replayHistory(reply, taskId);
}
