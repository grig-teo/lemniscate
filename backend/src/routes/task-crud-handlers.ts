import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { enqueueRunTask } from '../lib/proposal-scheduler.js';
import { prisma } from '../lib/prisma.js';
import { attachmentsData } from '../lib/task-attachments.js';
import { parseSkillSlugs } from '../lib/task-skills.js';
import {
  serializeTaskWithUsage,
  USAGE_CONFIG_SELECT,
  type UsageConfigInfo,
} from '../lib/usage.js';
import { requestTaskTitle, fallbackTaskTitle } from '../lib/task-title.js';
import { findLlmConfig } from '../lib/agent-runtime.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import {
  attachmentValidationError,
  archivedTasksWhere,
  initialTaskStatus,
  ownedTaskWhere,
  resolveAttachmentUpdate,
} from './task-lifecycle.js';
import { createBodySchema, idParamsSchema, listQuerySchema } from './task-schemas.js';

// Read/create task handlers: list, create (+ enqueue), and single-fetch.

const TASK_LIST_LIMIT = 100;

// Enabled configs of the user, fetched once per request to resolve each
// task's effective maxTokensPerRun budget (and prices for the cost estimate).
async function loadUsageConfigs(userId: string): Promise<UsageConfigInfo[]> {
  return prisma.llmConfig.findMany({ where: { userId, enabled: true }, select: USAGE_CONFIG_SELECT });
}

// List tasks, newest first. Optional ?repositoryId= filter; always scoped
// to repositories owned by the authenticated user.
export async function listTasks(request: FastifyRequest, reply: FastifyReply) {
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
  const repoIds = Array.from(new Set(tasks.map((task) => task.repositoryId)));
  const [repositories, configs] = await Promise.all([
    prisma.repository.findMany({
      where: { id: { in: repoIds } },
      select: { id: true, llmConfigId: true },
    }),
    loadUsageConfigs(userId),
  ]);
  const repoConfigById = new Map(repositories.map((repo) => [repo.id, repo.llmConfigId]));
  return {
    tasks: tasks.map((task) =>
      serializeTaskWithUsage(task, repoConfigById.get(task.repositoryId) ?? null, configs),
    ),
  };
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

// Create a prompt task and enqueue it for the agent worker (unless saved
// for later, in which case it stays pending until started).
export async function createTask(request: FastifyRequest, reply: FastifyReply) {
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

  // Per-user cap on concurrent work: queued + running tasks across all of
  // the user's repositories.
  const activeCount = await prisma.task.count({
    where: {
      status: { in: ['queued', 'running'] },
      repository: { connection: { userId } },
    },
  });
  if (activeCount >= config.TASK_MAX_ACTIVE_PER_USER) {
    return reply.code(429).send({
      error: `Active task limit reached (${config.TASK_MAX_ACTIVE_PER_USER}) — wait for a running task to finish`,
    });
  }

  const llmConfigId = await resolveTaskLlmConfigId(userId, repository, data.llmConfigId);
  if (llmConfigId === undefined) {
    return reply.code(400).send({ error: 'LLM config not found or disabled' });
  }
  if (!llmConfigId) {
    return reply.code(400).send({ error: 'no LLM config' });
  }
  const validationError = await attachmentValidationError(data, userId);
  if (validationError) {
    return reply.code(400).send({ error: validationError });
  }

  const task = await prisma.task.create({
    data: {
      repositoryId: data.repositoryId,
      kind: 'prompt',
      // Synchronous placeholder title; an LLM-summarized title replaces it
      // asynchronously (reviveGeneratedTitle below) so creation never blocks
      // on the LLM being unavailable.
      title: fallbackTaskTitle(data.prompt),
      prompt: data.prompt,
      status: initialTaskStatus(data.later),
      llmConfigId,
      thinkingLevel: data.thinkingLevel ?? null,
      // Explicit composer selections win; otherwise snapshot the repository's
      // skills so later edits don't retroactively change this task.
      skills: data.skills ?? parseSkillSlugs(repository.skillSlugs),
      ...attachmentsData(data.images),
      ...(await resolveAttachmentUpdate(data, userId)),
    },
  });

  // Best-effort: summarize the raw prompt into a concise imperative title.
  // Fire-and-forget — the row already has a valid fallback title; a failure
  // or slow LLM never blocks creation or the queue add below.
  void reviveGeneratedTitle(task.id, userId, data.prompt);

  // Enqueue exclusively through the jobId-deduped helper (single enqueue
  // path for run-task, AGENTS.md §6): a double-submit or client retry of
  // this route cannot create a second live job for the same task. A
  // save-for-later task gets no job until POST /tasks/:id/start.
  if (!data.later) {
    await enqueueRunTask(task.id);
  }

  const configs = await loadUsageConfigs(userId);
  return reply.code(201).send({ task: serializeTaskWithUsage(task, repository.llmConfigId, configs) });
}

// Async title generation: resolve the LLM config via the canonical resolver
// (task override → repository → user default), ask it for a concise imperative
// title, and update the task row when the result is usable and differs from the
// placeholder. All failures are swallowed (AGENTS.md §7 fallback-safe) — the
// task already has a valid title from createTask.
async function reviveGeneratedTitle(taskId: string, userId: string, prompt: string): Promise<void> {
  try {
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { llmConfigId: true } });
    const repo = await prisma.repository.findFirst({
      where: { tasks: { some: { id: taskId } } },
      select: { llmConfigId: true },
    });
    if (!repo) return;
    const cfg = await findLlmConfig(task, repo, userId);
    if (!cfg) return;
    const title = await requestTaskTitle(cfg, prompt);
    if (title && title !== fallbackTaskTitle(prompt)) {
      await prisma.task.update({ where: { id: taskId }, data: { title } });
    }
  } catch {
    // LLM unavailable / errored — keep the fallback title; never throw.
  }
}

// Single task (with its repository), ownership-scoped.
export async function getTask(request: FastifyRequest, reply: FastifyReply) {
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
  const configs = await loadUsageConfigs(userId);
  return { task: serializeTaskWithUsage(task, task.repository.llmConfigId, configs) };
}
