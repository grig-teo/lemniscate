import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AGENT_EXECUTORS,
  defaultAgentExecutor,
  parseAgentExecutor,
  type AgentExecutor,
} from '../lib/agent-executor.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId, requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// Per-user settings. Currently a single setting: the core agent executor
// (Settings → Agent). GET reports the effective value plus the deployment
// default so the UI can mark "default"; PUT stores the override on the
// User row (lib/agent-executor.ts resolves it for every agent job).

const putAgentExecutorSchema = z.object({
  agentExecutor: z.enum(AGENT_EXECUTORS),
});

interface SettingsPayload {
  agentExecutor: AgentExecutor;
  defaultAgentExecutor: AgentExecutor;
  override: AgentExecutor | null;
}

function settingsPayload(override: AgentExecutor | null): SettingsPayload {
  return {
    agentExecutor: override ?? defaultAgentExecutor(),
    defaultAgentExecutor: defaultAgentExecutor(),
    override,
  };
}

async function getSettings(request: FastifyRequest, _reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { agentExecutor: true },
  });
  return settingsPayload(parseAgentExecutor(user?.agentExecutor));
}

async function putAgentExecutor(request: FastifyRequest, reply: FastifyReply) {
  const body = parseOrReply(putAgentExecutorSchema, request.body, reply, 'Invalid settings');
  if (body === null) return;
  const userId = authenticatedUserId(request);
  const user = await prisma.user.update({
    where: { id: userId },
    data: { agentExecutor: body.agentExecutor },
    select: { agentExecutor: true },
  });
  return settingsPayload(parseAgentExecutor(user.agentExecutor));
}

const settingsRoutes = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);
  app.get('/', getSettings);
  app.put('/agent-executor', putAgentExecutor);
};

export default settingsRoutes;
