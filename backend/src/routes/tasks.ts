import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { config } from '../config.js';
import { enqueueRunTask, getAgentTasksQueue } from '../lib/proposal-scheduler.js';
import { prisma } from '../lib/prisma.js';
import { attachmentsData, taskImagesSchema, taskThinkingLevelSchema } from '../lib/task-attachments.js';
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

const promptSchema = z.string().min(1).max(8000);

const createBodySchema = z
  .object({
    repositoryId: z.string().min(1),
    prompt: promptSchema,
    // Per-task override of the LLM config's thinkingLevel; omit to inherit.
    thinkingLevel: taskThinkingLevelSchema.optional(),
    // Explicit LLM config chosen in the composer; omit to inherit (repo → default).
    llmConfigId: z.string().min(1).optional(),
    // Image attachments sent to the agent as multimodal content (max 3).
    images: taskImagesSchema.optional(),
  })
  .strict();

// Optional edits applied when a pending proposal is started. Absent body
// (the left-nav play button) parses as {} and changes nothing.
export const startBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    prompt: promptSchema.optional(),
    images: taskImagesSchema.optional(),
  })
  .strict()
  .default({});
export type StartBody = z.infer<typeof startBodySchema>;

const idParamsSchema = z.object({ id: z.string().min(1) });

const CANCELLABLE_STATUSES = ['pending', 'queued', 'running'] as const;

// Ownership scope: task → repository → connection → user.
function ownedTaskWhere(userId: string, taskId: string) {
  return { id: taskId, repository: { connection: { userId } } };
}

// Explicit composer choice wins; then repo config; then the user's default.
async function resolveTaskLlmConfigId(
  userId: string,
  repository: { llmConfigId: string | null },
  explicitId?: string,
): Promise<string | null | undefined> {
  if (explicitId) {
    const owned = await prisma.llmConfig.findFirst({
      where: { id: explicitId, userId, enabled: true },
      select: { id: true },
    });
    // Undefined signals "explicit id not usable" so the caller can 400.
    if (!owned) return undefined;
    return owned.id;
  }
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

  const llmConfigId = await resolveTaskLlmConfigId(userId, repository, data.llmConfigId);
  if (llmConfigId === undefined) {
    return reply.code(400).send({ error: 'LLM config not found or disabled' });
  }
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
      thinkingLevel: data.thinkingLevel ?? null,
      ...attachmentsData(data.images),
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

// Start eligibility for POST /tasks/:id/start: returns why a task cannot be
// started, or null when it can. Only pending proposals are click-to-run.
export function startBlocker(task: { kind: string; status: string }): string | null {
  if (task.kind !== 'proposal') return 'only proposal tasks can be started';
  if (task.status !== 'pending') return `task is ${task.status}, not pending`;
  return null;
}

// Update applied when a proposal is started: always queues the task; any
// edited fields (title/prompt/attachments) are written in the same update.
export function buildStartUpdate(body: StartBody) {
  return {
    status: 'queued' as const,
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
    ...attachmentsData(body.images),
  };
}

// Start a pending proposal task: apply any edits, mark it queued, and
// enqueue its run-task job.
async function startTask(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const body = parseOrReply(startBodySchema, request.body ?? {}, reply, 'Invalid request body', {
    includeIssues: true,
  });
  if (body === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: { id: true, kind: true, status: true },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }
  const blocker = startBlocker(task);
  if (blocker) {
    return reply.code(400).send({ error: blocker });
  }

  // Enqueue before the status update: a failed enqueue must not strand the
  // task in 'queued' without a job (the worker also sweeps these at boot).
  await enqueueRunTask(task.id);
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: buildStartUpdate(body),
  });
  return { task: updated };
}

// Rerun eligibility for POST /tasks/:id/rerun: only failed tasks (including
// user-cancelled ones, which are stored as failed) can be run again.
export function rerunBlocker(task: { status: string }): string | null {
  if (task.status !== 'failed') return `task is ${task.status}, not failed`;
  return null;
}

// Rerunning resets the run state: re-queued from scratch with a fresh
// branch, no leftover error or PR link.
export function buildRerunUpdate() {
  return { status: 'queued' as const, error: null, branchName: null, prUrl: null };
}

// Rerun a failed task: reset its run state, re-queue, and enqueue run-task.
async function rerunTask(request: FastifyRequest, reply: FastifyReply) {
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
  const blocker = rerunBlocker(task);
  if (blocker) {
    return reply.code(400).send({ error: blocker });
  }

  // Enqueue before the status update (same anti-stranding rule as startTask).
  await enqueueRunTask(task.id);
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: buildRerunUpdate(),
  });
  return { task: updated };
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

// SSE is served only when the client explicitly asks for it (EventSource
// always sends Accept: text/event-stream). Everything else — fetch's
// default included — gets the JSON history; otherwise a plain fetch hangs
// on the open stream forever ("Loading task history…" bug).
export function wantsSse(accept: string | undefined): boolean {
  return accept?.includes('text/event-stream') ?? false;
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

  if (!wantsSse(request.headers.accept)) {
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
  app.post('/tasks/:id/start', startTask);
  app.post('/tasks/:id/rerun', rerunTask);
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
