import { config } from '../config.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

// Core agent executor selection — the single home for "which agent runs
// tasks" (AGENTS.md §6). 'lemcore' is the only executor: the structured
// TypeScript agent loop with per-step events.
//
// Resolution order: the per-user override (User.agentExecutor, set in
// Settings → Agent) wins when present; otherwise the deployment default
// (AGENT_EXECUTOR env var) applies.

export const AGENT_EXECUTORS = ['lemcore'] as const;
export type AgentExecutor = (typeof AGENT_EXECUTORS)[number];

export function parseAgentExecutor(value: unknown): AgentExecutor | null {
  return typeof value === 'string' && (AGENT_EXECUTORS as readonly string[]).includes(value)
    ? (value as AgentExecutor)
    : null;
}

export function defaultAgentExecutor(): AgentExecutor {
  return parseAgentExecutor(config.AGENT_EXECUTOR) ?? 'lemcore';
}

export async function resolveAgentExecutor(userId: string): Promise<AgentExecutor> {
  let stored: unknown = null;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { agentExecutor: true },
    });
    stored = user?.agentExecutor ?? null;
  } catch (err) {
    logger.warn({ err, userId }, 'executor lookup failed; using the deployment default');
  }
  return parseAgentExecutor(stored) ?? defaultAgentExecutor();
}
