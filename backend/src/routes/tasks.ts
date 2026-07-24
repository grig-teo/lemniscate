import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { config } from '../config.js';
import { enqueueRunTask, getAgentTasksQueue } from '../lib/proposal-scheduler.js';
import { prisma } from '../lib/prisma.js';
import { attachmentsData, taskImagesSchema, taskThinkingLevelSchema } from '../lib/task-attachments.js';
import { publishTaskEvent, serializeTaskEvent } from '../lib/task-events.js';
import {
  findUnknownMcpServerSlugs,
  findUnknownSkillSlugs,
  isAgentsMdSkill,
  parseSkillSlugs,
  resolveAgentsMdFileContents,
  resolveMcpServerConfigs,
} from '../lib/task-skills.js';
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
  // ?archived=true returns ONLY archived tasks; anything else excludes them.
  archived: z.enum(['true', 'false']).optional(),
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
    // Save-for-later: create the task as pending without enqueueing it.
    later: z.boolean().optional(),
  })
  .strict();

// Per-folder AGENTS.md attachment entry: uploaded content or an agents_md
// template skill id. Shared by the start and PATCH bodies.
const agentsMdFileSchema = z.object({
  folder: z.string().min(1).max(500),
  skillId: z.string().min(1).optional(),
  content: z.string().max(100_000).optional(),
});

// Editable library attachments on a pending task. Undefined = leave the
// stored value untouched; an explicit empty array clears it.
const attachmentFieldsSchema = z.object({
  // Skill slugs injected into the agent's system prompt for this run.
  skills: z.array(z.string().min(1)).max(20).optional(),
  // MCP server slugs materialized as .mcp.json in the workdir.
  mcpServerSlugs: z.array(z.string().min(1)).max(20).optional(),
  // Per-folder AGENTS.md files written into the workdir.
  agentsMdFiles: z.array(agentsMdFileSchema).max(50).optional(),
});

// Optional edits applied when a pending task is started. Absent body
// (the left-nav play button) parses as {} and changes nothing.
export const startBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    prompt: promptSchema.optional(),
    images: taskImagesSchema.optional(),
  })
  .merge(attachmentFieldsSchema)
  .strict()
  .default({});
export type StartBody = z.infer<typeof startBodySchema>;

// PATCH /tasks/:id — save edits on a pending task without starting it.
export const patchBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    prompt: promptSchema.optional(),
    images: taskImagesSchema.optional(),
  })
  .merge(attachmentFieldsSchema)
  .strict();
export type PatchBody = z.infer<typeof patchBodySchema>;

const idParamsSchema = z.object({ id: z.string().min(1) });

const CANCELLABLE_STATUSES = ['pending', 'queued', 'running'] as const;

// Archive eligibility for POST /tasks/:id/archive: anything except running
// and queued (about to run) tasks can be archived.
const UNARCHIVABLE_STATUSES = ['running', 'queued'] as const;

export function isArchivable(status: string): boolean {
  return !(UNARCHIVABLE_STATUSES as readonly string[]).includes(status);
}

// GET /tasks archived filter: archived tasks are hidden by default; with
// ?archived=true ONLY the archived ones are returned.
export function archivedTasksWhere(archived?: boolean) {
  return archived ? { archivedAt: { not: null } } : { archivedAt: null };
}

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
      ...archivedTasksWhere(query.archived === 'true'),
    },
    orderBy: { createdAt: 'desc' },
    take: TASK_LIST_LIMIT,
  });
  return { tasks };
}

// Initial status of a freshly created prompt task: queued (enqueued right
// away) by default; `later: true` parks it as pending for click-to-start.
export function initialTaskStatus(later: boolean | undefined): 'queued' | 'pending' {
  return later ? 'pending' : 'queued';
}

// Create a prompt task and enqueue it for the agent worker (unless saved
// for later, in which case it stays pending until started).
async function createTask(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const data = parseOrReply(createBodySchema, request.body, reply, 'Invalid request body', {
    includeIssues: true,
  });
  if (data === null) return;

  const repository = await prisma.repository.findFirst({
    where: { id: data.repositoryId, connection: { userId } },
    select: { id: true, llmConfigId: true, skillSlugs: true },
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
      status: initialTaskStatus(data.later),
      llmConfigId,
      thinkingLevel: data.thinkingLevel ?? null,
      // Snapshot the repository's skills so later edits don't retroactively
      // change this task; empty array when the repo has none selected.
      skills: parseSkillSlugs(repository.skillSlugs),
      ...attachmentsData(data.images),
    },
  });

  // Same queue/job name as the worker; route-local options (no jobId
  // dedupe, immediate removal on completion) preserved as before. A
  // save-for-later task gets no job until POST /tasks/:id/start.
  if (!data.later) {
    await getAgentTasksQueue().add(RUN_TASK_JOB, { taskId: task.id }, { removeOnComplete: true });
  }

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
// started, or null when it can. Pending proposals and saved-for-later
// prompts are click-to-run.
const STARTABLE_KINDS = ['proposal', 'prompt'];

export function startBlocker(task: { kind: string; status: string }): string | null {
  if (!STARTABLE_KINDS.includes(task.kind)) {
    return 'only proposal and prompt tasks can be started';
  }
  if (task.status !== 'pending') return `task is ${task.status}, not pending`;
  return null;
}

// Update applied when a pending task is started: always queues the task; any
// edited fields (title/prompt/attachments/library selections) are written in
// the same update. Undefined attachment fields leave the column untouched;
// an explicit empty array clears it.
export function buildStartUpdate(body: StartBody) {
  return {
    status: 'queued' as const,
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
    ...attachmentsData(body.images),
    ...(body.skills !== undefined ? { skills: body.skills } : {}),
  };
}

// Async part of the attachment update: slugs are resolved to the stored
// configs/contents so a later library edit can't retroactively change the run.
export async function resolveAttachmentUpdate(body: PatchBody) {
  return {
    ...(body.mcpServerSlugs !== undefined
      ? { mcpServers: (await resolveMcpServerConfigs(body.mcpServerSlugs)) as Prisma.InputJsonValue }
      : {}),
    ...(body.agentsMdFiles !== undefined
      ? { agentsMdFiles: (await resolveAgentsMdFileContents(body.agentsMdFiles)) as Prisma.InputJsonValue }
      : {}),
  };
}

// Validates the attachment fields of a start/PATCH body; returns the 400
// message or null. Unknown slugs are named in the error.
export async function attachmentValidationError(body: PatchBody): Promise<string | null> {
  if (body.skills) {
    const unknown = await findUnknownSkillSlugs(body.skills);
    if (unknown.length > 0) return `Unknown skill slug(s): ${unknown.join(', ')}`;
  }
  if (body.mcpServerSlugs) {
    const unknown = await findUnknownMcpServerSlugs(body.mcpServerSlugs);
    if (unknown.length > 0) return `Unknown MCP server slug(s): ${unknown.join(', ')}`;
  }
  for (const entry of body.agentsMdFiles ?? []) {
    if (entry.skillId && !(await isAgentsMdSkill(entry.skillId))) {
      return `agentsMdFiles skillId does not reference an AGENTS.md skill: ${entry.skillId}`;
    }
  }
  return null;
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
  const validationError = await attachmentValidationError(body);
  if (validationError) {
    return reply.code(400).send({ error: validationError });
  }

  // Enqueue before the status update: a failed enqueue must not strand the
  // task in 'queued' without a job (the worker also sweeps these at boot).
  await enqueueRunTask(task.id);
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { ...buildStartUpdate(body), ...(await resolveAttachmentUpdate(body)) },
  });
  return { task: updated };
}

// Save edits on a pending proposal/prompt without starting it. Same body and
// validation as start; the task stays pending.
async function patchTask(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const body = parseOrReply(patchBodySchema, request.body ?? {}, reply, 'Invalid request body', {
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
  const validationError = await attachmentValidationError(body);
  if (validationError) {
    return reply.code(400).send({ error: validationError });
  }
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...attachmentsData(body.images),
      ...(body.skills !== undefined ? { skills: body.skills } : {}),
      ...(await resolveAttachmentUpdate(body)),
    },
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

// Archive a task: hide it from the task lists. Running and queued tasks
// cannot be archived — cancel them first.
async function archiveTask(request: FastifyRequest, reply: FastifyReply) {
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
  if (!isArchivable(task.status)) {
    return reply.code(409).send({ error: `Task is ${task.status} and cannot be archived` });
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { archivedAt: new Date() },
  });
  return { task: updated };
}

// Unarchive a task: clear archivedAt so it reappears in the task lists.
async function unarchiveTask(request: FastifyRequest, reply: FastifyReply) {
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

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { archivedAt: null },
  });
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
  app.patch('/tasks/:id', patchTask);
  app.post('/tasks/:id/rerun', rerunTask);
  app.post('/tasks/:id/cancel', cancelTask);
  app.post('/tasks/:id/archive', archiveTask);
  app.post('/tasks/:id/unarchive', unarchiveTask);
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
