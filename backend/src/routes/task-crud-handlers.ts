import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getAgentTasksQueue, JOB_PRIORITY } from '../lib/proposal-scheduler.js';
import { prisma } from '../lib/prisma.js';
import { attachmentsData } from '../lib/task-attachments.js';
import { parseSkillSlugs } from '../lib/task-skills.js';
import {
  serializeTaskWithUsage,
  USAGE_CONFIG_SELECT,
  type UsageConfigInfo,
} from '../lib/usage.js';
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

export const RUN_TASK_JOB = 'run-task';
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
      title: data.prompt.slice(0, 80),
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

  // Same queue/job name as the worker; route-local options (no jobId
  // dedupe, immediate removal on completion) preserved as before. A
  // save-for-later task gets no job until POST /tasks/:id/start.
  if (!data.later) {
    await getAgentTasksQueue().add(
      RUN_TASK_JOB,
      { taskId: task.id },
      { removeOnComplete: true, priority: JOB_PRIORITY.userTask },
    );
  }

  const configs = await loadUsageConfigs(userId);
  return reply.code(201).send({ task: serializeTaskWithUsage(task, repository.llmConfigId, configs) });
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
