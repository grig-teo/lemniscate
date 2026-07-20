import type { LlmConfig, Repository } from '@/lib/hooks';

// Pure helpers for the console task composer: token estimation, context-window
// resolution, ring tone, textarea height clamping, and image accept rules.

/**
 * chars-per-token heuristic — mirrors the backend estimator
 * (backend/src/lib/agent-runtime.ts `billedTokens`, repo-context.ts).
 * Keep the two sides in sync; this is the single documented constant.
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Context window of the LLM config that will run the task: the selected
 * repo's llmConfigId config, otherwise the user's default config — the same
 * resolution order as the backend task route (routes/tasks.ts).
 */
export function resolveContextWindow(
  configs: LlmConfig[],
  repositories: Repository[],
  repositoryId: string,
): number | null {
  const repo = repositories.find((r) => r.id === repositoryId);
  const repoConfig = repo?.llmConfigId
    ? configs.find((c) => c.id === repo.llmConfigId)
    : undefined;
  const fallback = configs.find((c) => c.isDefault);
  return (repoConfig ?? fallback)?.contextWindow ?? null;
}

export type RingTone = 'muted' | 'amber' | 'red';

export const RING_AMBER_THRESHOLD = 0.6;
export const RING_RED_THRESHOLD = 0.9;

export function ringTone(ratio: number): RingTone {
  if (ratio > RING_RED_THRESHOLD) return 'red';
  if (ratio > RING_AMBER_THRESHOLD) return 'amber';
  return 'muted';
}

/** Clamp an auto-growing textarea's height between its min and max px bounds. */
export function clampTextareaHeight(
  scrollHeight: number,
  minHeight: number,
  maxHeight: number,
): number {
  return Math.min(Math.max(scrollHeight, minHeight), maxHeight);
}

// Image attachments: png/jpeg/webp/gif only, ≤2 MB each, max 3 per task
// (the backend enforces its own caps in src/lib/task-attachments.ts).
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export function isAcceptedImage(file: { type: string; size: number }): boolean {
  return IMAGE_ACCEPT.split(',').includes(file.type) && file.size <= MAX_IMAGE_BYTES;
}
