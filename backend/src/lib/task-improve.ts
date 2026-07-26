import type { LlmConfig } from '@prisma/client';
import { proposalDocumentSectionLines } from './agent-prompts.js';
import { decrypt } from './crypto.js';
import { chatCompletions } from './llm-client.js';
import { prisma } from './prisma.js';

// POST /tasks/:id/improve helpers — the console pane's Improve button asks
// the LLM to rewrite a pending task's rough description into the structured
// document shape used for generated proposals (the section contract lives in
// agent-prompts.ts). Nothing is persisted: the route returns the improved
// text and the editor applies it, so Save/Start keeps working unchanged.
// The pure builders/sanitizers are unit-tested in tests/task-improve.test.ts.

// Same ceiling as the generated-proposal prompt field (llmProposalSchema).
export const IMPROVED_PROMPT_MAX_CHARS = 16_000;

// System prompt for the rewrite: the proposal document sections, minus the
// repo-exploration parts (this lightweight call never clones the repository).
export function improvePromptSystemPrompt(systemPromptExtra: string | null): string {
  return [
    'You are a senior software architect and product consultant.',
    "Rewrite the user's rough task description into a complete task document in markdown, with exactly these sections:",
    ...proposalDocumentSectionLines(),
    'Keep every requirement from the original description — enrich it with detail and structure, never drop or contradict it.',
    'End the document with a one-line directive the implementing coding agent can execute directly.',
    'Respond with the improved task document ONLY — plain markdown, no JSON wrapper, no markdown fences around the whole document, no commentary.',
    ...(systemPromptExtra
      ? ['', 'Additional instructions from the repository owner:', systemPromptExtra]
      : []),
  ].join('\n');
}

export function improvePromptUserContent(title: string | undefined, prompt: string): string {
  return [...(title ? [`# Task\n${title}`, ''] : []), prompt].join('\n');
}

// Normalizes the LLM's document: unwraps a single whole-document markdown
// fence, trims, caps the length. Empty/unusable output degrades to the
// caller's original prompt so the editor never blanks out.
export function sanitizeImprovedPrompt(raw: string, fallback: string): string {
  const fenced = raw.trim().match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  const text = (fenced?.[1] ?? raw).trim();
  if (!text) return fallback;
  return text.slice(0, IMPROVED_PROMPT_MAX_CHARS);
}

// Config resolution mirrors task creation: the task's own config wins, then
// the repository's, then the user's default — disabled configs are skipped.
export async function resolveImproveLlmConfig(
  userId: string,
  task: { llmConfigId: string | null; repository: { llmConfigId: string | null } },
): Promise<LlmConfig | null> {
  const candidateIds = [task.llmConfigId, task.repository.llmConfigId];
  for (const id of candidateIds) {
    if (!id) continue;
    const cfg = await prisma.llmConfig.findFirst({ where: { id, userId, enabled: true } });
    if (cfg) return cfg;
  }
  return prisma.llmConfig.findFirst({ where: { userId, isDefault: true, enabled: true } });
}

// One lightweight chat call (same shape as the library structure-preview):
// no repo clone, no job — the improved text comes back in the response.
export async function requestImprovedPrompt(
  cfg: LlmConfig,
  input: { title?: string; prompt: string },
): Promise<string> {
  const result = await chatCompletions({
    baseUrl: cfg.baseUrl,
    apiKey: decrypt(cfg.apiKeyEnc),
    model: cfg.model,
    messages: [
      { role: 'system', content: improvePromptSystemPrompt(cfg.systemPromptExtra) },
      { role: 'user', content: improvePromptUserContent(input.title, input.prompt) },
    ],
    temperature: 0.3,
    maxTokens: Math.min(cfg.maxTokens, 8000),
    timeoutSeconds: cfg.timeoutSeconds,
    maxRetries: 1,
    customHeaders: {},
  });
  return sanitizeImprovedPrompt(result.content, input.prompt);
}
