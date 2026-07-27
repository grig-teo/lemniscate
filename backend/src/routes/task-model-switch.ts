import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { publishTaskEvent } from '../lib/task-events.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { modelSwitchBlocker, ownedTaskWhere } from './task-lifecycle.js';
import { idParamsSchema, modelBodySchema } from './task-schemas.js';

// Switch the LLM config of an in-flight task (the console footer's model
// dropdown). Split out of task-action-handlers.ts (AGENTS.md §2 file-size
// limit); re-exported there so tasks.ts keeps a single import site.
export async function switchTaskModel(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid task id');
  if (params === null) return;
  const body = parseOrReply(modelBodySchema, request.body, reply, 'Invalid request body', {
    includeIssues: true,
  });
  if (body === null) return;
  const task = await prisma.task.findFirst({
    where: ownedTaskWhere(userId, params.id),
    select: { id: true, status: true },
  });
  if (!task) {
    return reply.code(404).send({ error: 'Task not found' });
  }
  const blocker = modelSwitchBlocker(task);
  if (blocker) {
    return reply.code(400).send({ error: blocker });
  }
  const config = await prisma.llmConfig.findFirst({
    where: { id: body.llmConfigId, userId, enabled: true },
    select: { id: true, name: true, model: true },
  });
  if (!config) {
    return reply.code(400).send({ error: 'LLM config not found or disabled' });
  }
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { llmConfigId: config.id },
  });
  await publishTaskEvent(task.id, 'log', {
    line: `⇄ model switch requested → ${config.model} [${config.name}] — takes effect on the next LLM call`,
  });
  return { task: updated };
}
