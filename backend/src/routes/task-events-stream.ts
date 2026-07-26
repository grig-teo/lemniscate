import type { FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { serializeTaskEvent } from '../lib/task-events.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { ownedTaskWhere, wantsSse } from './task-lifecycle.js';
import { idParamsSchema } from './task-schemas.js';

// Task events handler + SSE stream. Event contract (shared with the worker,
// implemented in src/lib/task-events.ts): Redis pub/sub channel
// `task-events:<taskId>`, message JSON {id, kind, payload, createdAt} with
// createdAt as an ISO string. Payloads:
//   log    → { line: string }
//   status → { status: 'pending'|'queued'|'running'|'awaiting_review'|'done'|'failed'|'closed' }
//   diff   → { path: string, diff: string } | { path: string, action: 'created'|'modified'|'deleted' }

const SSE_HEARTBEAT_MS = 15_000;

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
    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: 'asc' },
    });
    return events.map(serializeTaskEvent);
  }

  return streamTaskEvents(request, reply, task.id);
}

// Replay persisted history first (ascending), then follow live events.
async function replayHistory(reply: FastifyReply, taskId: string): Promise<void> {
  const history = await prisma.taskEvent.findMany({
    where: { taskId },
    orderBy: { createdAt: 'asc' },
  });
  for (const event of history) {
    reply.raw.write(`data: ${JSON.stringify(serializeTaskEvent(event))}\n\n`);
  }
}

// Dedicated connection: a Redis client in subscribe mode cannot run other
// commands, so it must not be the shared publisher.
async function followLiveEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  taskId: string,
): Promise<void> {
  const subscriber = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.on('message', (_channel: string, message: string) => {
    reply.raw.write(`data: ${message}\n\n`);
  });
  await subscriber.subscribe(`task-events:${taskId}`);

  const heartbeat = setInterval(() => {
    reply.raw.write(': ping\n\n');
  }, SSE_HEARTBEAT_MS);

  request.raw.on('close', () => {
    clearInterval(heartbeat);
    void subscriber.unsubscribe().finally(() => subscriber.quit());
  });
}

async function streamTaskEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  taskId: string,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  await replayHistory(reply, taskId);
  await followLiveEvents(request, reply, taskId);
}
