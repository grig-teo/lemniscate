import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { config } from '../config.js';
import { getAgentTasksQueue } from '../lib/proposal-scheduler.js';
import { prisma } from '../lib/prisma.js';
import { publishTaskEvent, serializeTaskEvent } from '../lib/task-events.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// Tasks API + SSE event stream. Registered under prefix `/api` (paths below
// include the `/tasks` segment, matching routes/repositories.ts).
//
// Event contract (shared with the worker, implemented in
// src/lib/task-events.ts): Redis pub/sub channel `task-events:<taskId>`,
// message JSON {id, kind, payload, createdAt} with createdAt as an ISO
// string. Payloads:
//   log    → { line: string }
//   status → { status: 'pending'|'queued'|'running'|'awaiting_review'|'done'|'failed' }
//   diff   → { path: string, diff: string } | { path: string, action: 'created'|'modified'|'deleted' }

const RUN_TASK_JOB = 'run-task';
const TASK_LIST_LIMIT = 100;
const SSE_HEARTBEAT_MS = 15_000;

const listQuerySchema = z.object({
  repositoryId: z.string().min(1).optional(),
});

const createBodySchema = z
  .object({
    repositoryId: z.string().min(1),
    prompt: z.string().min(1).max(8000),
  })
  .strict();

const idParamsSchema = z.object({ id: z.string().min(1) });

const CANCELLABLE_STATUSES = ['pending', 'queued', 'running'] as const;

// Ownership scope: task → repository → connection → user.
function ownedTaskWhere(userId: string, taskId: string) {
  return { id: taskId, repository: { connection: { userId } } };
}

// Repo-specific config wins; otherwise fall back to the user's default.
async function resolveTaskLlmConfigId(
  userId: string,
  repository: { llmConfigId: string | null },
): Promise<string | null> {
  if (repository.llmConfigId) return repository.llmConfigId;
  const defaultConfig = await prisma.llmConfig.findFirst({
    where: { userId, isDefault: true },
    select: { id: true },
  });
  return defaultConfig?.id ?? null;
}

// List tasks, newest first. Optional ?repositoryId= filter; always scoped
// to repositories owned by the authenticated user.
async function listTasks(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const query = parseOrReply(listQuerySchema, request.query, reply, 'Invalid query', {
    includeIssues: true,
  });
  if (query === null) return;
  const tasks = await prisma.task.findMany({
    where: {
      repository: { connection: { userId } },
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: TASK_LIST_LIMIT,
  });
  return { tasks };
}

// Create a prompt task and enqueue it for the agent worker.
async function createTask(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const data = parseOrReply(createBodySchema, request.body, reply, 'Invalid request body', {
    includeIssues: true,
  });
  if (data === null) return;

  const repository = await prisma.repository.findFirst({
    where: { id: data.repositoryId, connection: { userId } },
    select: { id: true, llmConfigId: true },
  });
  if (!repository) {
    return reply.code(404).send({ error: 'Repository not found' });
  }

  const llmConfigId = await resolveTaskLlmConfigId(userId, repository);
  if (!llmConfigId) {
    return reply.code(400).send({ error: 'no LLM config' });
  }

  const task = await prisma.task.create({
    data: {
      repositoryId: data.repositoryId,
      kind: 'prompt',
      title: data.prompt.slice(0, 80),
      prompt: data.prompt,
      status: 'queued',
      llmConfigId,
    },
  });

  // Same queue/job name as the worker; route-local options (no jobId
  // dedupe, immediate removal on completion) preserved as before.
  await getAgentTasksQueue().add(RUN_TASK_JOB, { taskId: task.id }, { removeOnComplete: true });

  return reply.code(201).send({ task });
}

// Single task (with its repository), ownership-scoped.
async function getTask(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    include: { repository: true },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }
  return { task };
}

// Cancel a task that hasn't finished yet.
async function cancelTask(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: { id: true, status: true },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }
  if (!(CANCELLABLE_STATUSES as readonly string[]).includes(task.status)) {
    return reply.code(409).send({ error: `Task is ${task.status} and cannot be cancelled` });
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { status: 'failed', error: 'cancelled by user' },
  });
  await publishTaskEvent(task.id, 'status', { status: 'failed' });
  return { task: updated };
}

// Task events: full history as JSON when the client asks for it,
// otherwise a live SSE stream (history replay + pub/sub follow).
async function getTaskEvents(request: FastifyRequest, reply: FastifyReply) {
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

  if (request.headers.accept?.includes('application/json')) {
    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: 'asc' },
    });
    return events.map(serializeTaskEvent);
  }

  return streamTaskEvents(request, reply, task.id);
}

const tasksRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.get('/tasks', listTasks);
  app.post('/tasks', createTask);
  app.get('/tasks/:id', getTask);
  app.post('/tasks/:id/cancel', cancelTask);
  app.get('/tasks/:id/events', getTaskEvents);
};

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

export default tasksRoutes;
