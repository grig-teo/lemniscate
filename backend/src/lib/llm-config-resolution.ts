import type { LlmConfig } from '@prisma/client';
import { filterHealthyConfigs } from './llm-exhaustion.js';
import { prisma } from './prisma.js';

// LLM config resolution: which config a run starts on. Split out of
// agent-runtime.ts to keep that module under the 300-line guard baseline
// (AGENTS.md section 2); agent-runtime re-exports the public surface so
// existing importers keep one import path.

async function findEnabledById(id: string, userId: string): Promise<LlmConfig | null> {
  return prisma.llmConfig.findFirst({ where: { id, userId, enabled: true } });
}

async function findUserFallback(userId: string): Promise<LlmConfig | null> {
  const candidates = await prisma.llmConfig.findMany({
    where: { userId, enabled: true },
    orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
  });
  // Configs parked after hitting their provider's rate/token limit
  // (llm-exhaustion.ts) are skipped, so a fresh run starts directly on the
  // healthy promoted config instead of burning retries against the
  // still-limited default. The parked default returns automatically when its
  // cooldown record expires; when every config is parked, degrade to the
  // stored order — the in-run failover chain absorbs a still-limited pick.
  const healthy = await filterHealthyConfigs(candidates);
  return healthy[0] ?? candidates[0] ?? null;
}

// Resolution order: task.llmConfigId → repo.llmConfigId → user's default →
// any enabled config of the user. Single source of truth for every caller
// (task runs, improve, …) — parameterized on llmConfigId so partial task
// selects fit. Returns null when nothing matches.
export async function findLlmConfig(
  task: { llmConfigId: string | null } | null,
  repository: { llmConfigId: string | null },
  userId: string,
): Promise<LlmConfig | null> {
  for (const id of [task?.llmConfigId, repository.llmConfigId]) {
    if (!id) continue;
    const found = await findEnabledById(id, userId);
    if (found) return found;
  }
  return findUserFallback(userId);
}

export async function resolveLlmConfig(
  task: { llmConfigId: string | null } | null,
  repository: { llmConfigId: string | null },
  userId: string,
): Promise<LlmConfig> {
  const fallback = await findLlmConfig(task, repository, userId);
  if (!fallback) {
    throw new Error(
      'No enabled LLM config found (task override, repository config, and user default are all unset)',
    );
  }
  return fallback;
}
