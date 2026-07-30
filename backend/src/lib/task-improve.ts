import type { LlmConfig } from '@prisma/client';
import { proposalDocumentSectionLines } from './agent-prompts.js';
import { resolveLlmAccessToken } from './llm-access-token.js';
import { chatCompletion } from './llm-dispatch.js';

// POST /tasks/:id/improve helpers — the console pane's Improve button asks
// the LLM to rewrite a pending task's rough description into the structured
// document shape used for generated proposals (the section contract lives in
// agent-prompts.ts). Nothing is persisted: the route returns the improved
// text and the editor applies it, so Save/Start keeps working unchanged.
// The pure builders/sanitizers are unit-tested in tests/task-improve.test.ts.

// Same ceiling as promptSchema (task-schemas.ts): the editor applies the
// improved text and always sends the changed prompt on Save/Start, so a
// longer document would fail PATCH /tasks/:id and POST /tasks/:id/start
// validation. Locked by tests/task-improve.test.ts.
export const IMPROVED_PROMPT_MAX_CHARS = 8_000;

// The Improve response also carries an LLM-generated time estimate for the
// improved document (shown as a badge next to the priority/effort labels in
// the proposal/prompt detail pane). Guard rails mirror the prompt ones:
// short and capped, empty/unusable output degrades to null so the UI simply
// hides the badge. Locked by tests/task-improve.test.ts.
export const ESTIMATE_TIME_MAX_CHARS = 40;

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

// LLM config resolution uses the shared resolver in agent-runtime.ts
// (findLlmConfig) — the route imports it directly so the task → repository →
// default → any-enabled chain lives in exactly one place.

// One lightweight chat call (same shape as the library structure-preview):
// no repo clone, no job — the text comes back in the response.
async function lightweightChat(
  cfg: LlmConfig,
  system: string,
  user: string,
  maxTokens: number,
) {
  return chatCompletion({
    baseUrl: cfg.baseUrl,
    apiKey: await resolveLlmAccessToken(cfg),
    model: cfg.model,
    apiPattern: cfg.apiPattern,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: cfg.temperature,
    maxTokens,
    timeoutSeconds: cfg.timeoutSeconds,
    maxRetries: 1,
    customHeaders: {},
  });
}

export async function requestImprovedPrompt(
  cfg: LlmConfig,
  input: { title?: string; prompt: string },
): Promise<string> {
  const result = await lightweightChat(
    cfg,
    improvePromptSystemPrompt(cfg.systemPromptExtra),
    improvePromptUserContent(input.title, input.prompt),
    Math.min(cfg.maxTokens, 8000),
  );
  return sanitizeImprovedPrompt(result.content, input.prompt);
}

// Time-estimate follow-up: a second lightweight chat call over the improved
// document, same connection (the user's configured LLM), no repo clone.
export function estimateTimeSystemPrompt(systemPromptExtra: string | null): string {
  return [
    'You are a senior software architect and delivery lead.',
    'Estimate how long ONE competent software engineer, assisted by an autonomous coding agent, would realistically take to implement the given task document end to end (implementation, tests, review round-trip).',
    'Respond with the estimate ONLY — one short phrase like "about 2 hours", "1-2 days", or "about a week". No JSON, no markdown, no explanation.',
    ...(systemPromptExtra
      ? ['', 'Additional instructions from the repository owner:', systemPromptExtra]
      : []),
  ].join('\n');
}

export function estimateTimeUserContent(title: string | undefined, prompt: string): string {
  return improvePromptUserContent(title, prompt);
}

// Normalizes the estimate to one short line: takes the first line, strips
// bullets/markdown emphasis, collapses whitespace, caps the length. Empty or
// unusable output degrades to null — the badge is hidden, never wrong.
export function sanitizeEstimatedTime(raw: string): string | null {
  const firstLine = raw.trim().split('\n')[0] ?? '';
  const text = firstLine
    .replace(/^[-*•>\s]+/, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.slice(0, ESTIMATE_TIME_MAX_CHARS);
}

export async function requestEstimatedTime(
  cfg: LlmConfig,
  input: { title?: string; prompt: string },
): Promise<string | null> {
  const result = await lightweightChat(
    cfg,
    estimateTimeSystemPrompt(cfg.systemPromptExtra),
    estimateTimeUserContent(input.title, input.prompt),
    64, // a short phrase — never the config's full budget
  );
  return sanitizeEstimatedTime(result.content);
}
