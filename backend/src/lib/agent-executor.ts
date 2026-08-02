import { logger } from './logger.js';
import { prisma } from './prisma.js';

// Core agent executor selection — the single home for "which agent runs
// tasks" (AGENTS.md §6). Lemcore — the structured TypeScript agent loop with
// per-step events — is the only agent. The setting machinery below survives
// so deployments where a user previously picked the removed 'hermes' or
// 'internal' executors (stored on User.agentExecutor) keep working: the
// stored value is ignored and lemcore runs.

export const AGENT_EXECUTORS = ['lemcore'] as const;
export type AgentExecutor = (typeof AGENT_EXECUTORS)[number];

export const LEMCORE_EXECUTOR: AgentExecutor = 'lemcore';

/** Narrows an untrusted stored value to a known executor, else null. */
export function parseAgentExecutor(value: unknown): AgentExecutor | null {
  return (AGENT_EXECUTORS as readonly unknown[]).includes(value)
    ? (value as AgentExecutor)
    : null;
}

/** Deployment default executor. */
export function defaultAgentExecutor(): AgentExecutor {
  return LEMCORE_EXECUTOR;
}

/** Effective executor for a user: their override, else the default. */
export async function resolveAgentExecutor(userId: string): Promise<AgentExecutor> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { agentExecutor: true },
    });
    return parseAgentExecutor(user?.agentExecutor) ?? defaultAgentExecutor();
  } catch (err) {
    logger.warn({ err, userId }, 'agent-executor: user lookup failed; using the default');
    return defaultAgentExecutor();
  }
}
