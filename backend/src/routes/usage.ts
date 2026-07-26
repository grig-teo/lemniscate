import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { buildUsageReport, USAGE_CONFIG_SELECT } from '../lib/usage.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// GET /api/usage?period=7d|30d — per-user LLM token usage, grouped by
// repository and by UTC day, with estimated USD cost when LLM configs have
// prices. See USAGE_SEMANTICS (returned in the payload) for the attribution
// model: llmTokensUsed is cumulative per task, so a task's whole total is
// attributed to the day it was created — an approximation, not event deltas.

const DAY_MS = 24 * 60 * 60 * 1000;

const querySchema = z.object({
  period: z.enum(['7d', '30d']).default('30d'),
});

async function getUsage(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const query = parseOrReply(querySchema, request.query, reply, 'Invalid query');
  if (query === null) return;
  const since = new Date(Date.now() - (query.period === '7d' ? 7 : 30) * DAY_MS);
  const [tasks, repositories, configs] = await Promise.all([
    prisma.task.findMany({
      where: { repository: { connection: { userId } }, createdAt: { gte: since } },
      select: {
        repositoryId: true,
        createdAt: true,
        llmTokensUsed: true,
        llmPromptTokens: true,
        llmCompletionTokens: true,
        llmConfigId: true,
      },
    }),
    prisma.repository.findMany({
      where: { connection: { userId } },
      select: { id: true, name: true, fullName: true, llmConfigId: true },
    }),
    prisma.llmConfig.findMany({
      where: { userId, enabled: true },
      select: USAGE_CONFIG_SELECT,
    }),
  ]);
  return buildUsageReport({ tasks, repositories, configs, period: query.period, since });
}

const usageRoutes = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);
  app.get('/usage', getUsage);
};

export default usageRoutes;
