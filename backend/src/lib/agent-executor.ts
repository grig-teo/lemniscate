import { config } from '../config.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

// Core agent executor selection — the single home for "which agent runs
// tasks" (AGENTS.md §6). 'hermes' shells out to the Hermes Agent CLI inside
// the cloned repo; 'internal' is the built-in single-shot LLM
// propose/apply loop (the in-house agent under development).
//
// Resolution order: the per-user override stored on User.agentExecutor
// (Settings → Agent) wins; the AGENT_EXECUTOR env var is the deployment
// default. A failed user lookup must never break a job — it falls back to
// the env default (and warns), so task execution is never hostage to a
// settings read.

export const AGENT_EXECUTORS = ['hermes', 'internal'] as const;
export type AgentExecutor = (typeof AGENT_EXECUTORS)[number];

/** Narrows an untrusted stored value to a known executor, else null. */
export function parseAgentExecutor(value: unknown): AgentExecutor | null {
  return (AGENT_EXECUTORS as readonly unknown[]).includes(value)
    ? (value as AgentExecutor)
    : null;
}

/** Deployment default from the AGENT_EXECUTOR env var. */
export function defaultAgentExecutor(): AgentExecutor {
  return config.AGENT_EXECUTOR;
}

/** Effective executor for a user: their override, else the env default. */
export async function resolveAgentExecutor(userId: string): Promise<AgentExecutor> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { agentExecutor: true },
    });
    return parseAgentExecutor(user?.agentExecutor) ?? defaultAgentExecutor();
  } catch (err) {
    logger.warn({ err, userId }, 'agent-executor: user lookup failed; using the env default');
    return defaultAgentExecutor();
  }
}
