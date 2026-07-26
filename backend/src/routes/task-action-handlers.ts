import type { FastifyReply, FastifyRequest } from 'fastify';
import { enqueueRunTask } from '../lib/proposal-scheduler.js';
import { prisma } from '../lib/prisma.js';
import { attachmentsData } from '../lib/task-attachments.js';
import { publishTaskEvent } from '../lib/task-events.js';
import { findLlmConfig } from '../lib/agent-runtime.js';
import { requestImprovedPrompt } from '../lib/task-improve.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import {
  attachmentValidationError,
  buildRerunUpdate,
  buildStartUpdate,
  CANCELLABLE_STATUSES,
  isArchivable,
  ownedTaskWhere,
  rerunBlocker,
  resolveAttachmentUpdate,
  startBlocker,
} from './task-lifecycle.js';
import { idParamsSchema, improveBodySchema, patchBodySchema, startBodySchema } from './task-schemas.js';

// Task action handlers: start, patch, rerun, cancel, archive, unarchive.
// Every handler is ownership-scoped via ownedTaskWhere.

// Start a pending proposal task: apply any edits, mark it queued, and
// enqueue its run-task job.
export async function startTask(request: FastifyRequest, reply: FastifyReply) {
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
  const validationError = await attachmentValidationError(body, userId);
  if (validationError) {
    return reply.code(400).send({ error: validationError });
  }

  // Enqueue before the status update: a failed enqueue must not strand the
  // task in 'queued' without a job (the worker also sweeps these at boot).
  await enqueueRunTask(task.id);
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { ...buildStartUpdate(body), ...(await resolveAttachmentUpdate(body, userId)) },
  });
  return { task: updated };
}

// Save edits on a pending proposal/prompt without starting it. Same body and
// validation as start; the task stays pending.
export async function patchTask(request: FastifyRequest, reply: FastifyReply) {
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
  const validationError = await attachmentValidationError(body, userId);
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
      ...(await resolveAttachmentUpdate(body, userId)),
    },
  });
  return { task: updated };
}

// Improve a pending task's description with the LLM (same structured shape
// as generated proposals). Same eligibility as start/PATCH; the improved
// text is returned to the editor without touching the stored task.
export async function improveTask(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const body = parseOrReply(improveBodySchema, request.body, reply, 'Invalid request body', {
    includeIssues: true,
  });
  if (body === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: {
      id: true,
      kind: true,
      status: true,
      llmConfigId: true,
      repository: { select: { llmConfigId: true } },
    },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }
  const blocker = startBlocker(task);
  if (blocker) {
    return reply.code(400).send({ error: blocker });
  }
  // Shared resolver (agent-runtime): task → repository → default → any
  // enabled config — same chain Start would use, so Improve never 400s in a
  // setup where running the task would succeed.
  const llmConfig = await findLlmConfig(task, task.repository, userId);
  if (!llmConfig) {
    return reply.code(400).send({ error: 'No LLM config — set one in Settings first' });
  }
  try {
    const prompt = await requestImprovedPrompt(llmConfig, body);
    return { prompt };
  } catch (err) {
    request.log.warn({ err }, 'task prompt improvement failed');
    return reply.code(502).send({ error: 'Prompt improvement failed — try again' });
  }
}

// Rerun a failed task: reset its run state, re-queue, and enqueue run-task.
export async function rerunTask(request: FastifyRequest, reply: FastifyReply) {
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
export async function cancelTask(request: FastifyRequest, reply: FastifyReply) {
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
export async function archiveTask(request: FastifyRequest, reply: FastifyReply) {
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
export async function unarchiveTask(request: FastifyRequest, reply: FastifyReply) {
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
