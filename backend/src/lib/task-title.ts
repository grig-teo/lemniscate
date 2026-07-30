import type { LlmConfig } from '@prisma/client';
import { resolveLlmAccessToken } from './llm-access-token.js';
import { chatCompletion } from './llm-dispatch.js';

// Auto-generated task titles (AGENTS.md "auto-generated titles"): on task
// creation the LLM summarizes the user's raw description into a concise,
// imperative-mood title instead of the previous naive `prompt.slice(0, 80)`.
// Mirrors task-improve.ts (one lightweight chat call, sanitize + fallback).
// The pure builders/sanitizers are unit-tested in tests/task-title.test.ts.

// Same ceiling as the prompt-editor title field (task-schemas.ts: max 200).
// Titles are shown in lists and cards, so a tight cap keeps them scannable.
export const TASK_TITLE_MAX_CHARS = 60;

// Naive truncation used as the immediate, synchronous fallback before the
// LLM title resolves (and when generation fails). Public so the createTask
// handler reuses the exact same shape for the placeholder title.
export function fallbackTaskTitle(prompt: string): string {
  const title = prompt.trim().replace(/\s+/g, ' ');
  if (title.length <= TASK_TITLE_MAX_CHARS) return title;
  return `${title.slice(0, TASK_TITLE_MAX_CHARS).trimEnd()}…`;
}

// System prompt for the summarizer: ask for a single concise imperative line.
export function taskTitleSystemPrompt(systemPromptExtra: string | null): string {
  return [
    'You are a senior engineering manager triaging a backlog.',
    'Generate a concise title for the following task description.',
    'Use the imperative mood (e.g. "Add login throttling", "Fix flaky CI cache").',
    `Maximum ${TASK_TITLE_MAX_CHARS} characters. Plain text only — no quotes, no markdown, no trailing punctuation.`,
    'Reply with the title ONLY — nothing else.',
    ...(systemPromptExtra
      ? ['', 'Additional instructions from the repository owner:', systemPromptExtra]
      : []),
  ].join('\n');
}

export function taskTitleUserContent(prompt: string): string {
  return prompt;
}

// Normalizes the LLM's reply to one short imperative line: takes the first
// non-empty line, strips wrapping quotes/markdown emphasis, collapses
// whitespace, caps the length. Empty/unusable output degrades to the caller's
// fallback so a task never has a blank title.
export function sanitizeTaskTitle(raw: string, fallback: string): string {
  const firstLine = raw.trim().split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const cleaned = firstLine.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= TASK_TITLE_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, TASK_TITLE_MAX_CHARS).trimEnd()}…`;
}

// One lightweight chat call (same shape as task-improve.ts): no repo clone,
// no job — the title comes back in the response. Falls back on any error so
// task creation never blocks on the LLM being unavailable.
async function lightweightChat(
  cfg: LlmConfig,
  system: string,
  user: string,
): Promise<string> {
  const result = await chatCompletion({
    baseUrl: cfg.baseUrl,
    apiKey: await resolveLlmAccessToken(cfg),
    model: cfg.model,
    apiPattern: cfg.apiPattern,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: cfg.temperature,
    maxTokens: 32, // a short title — never the config's full budget
    timeoutSeconds: cfg.timeoutSeconds,
    maxRetries: 1,
    customHeaders: {},
  });
  return result.content;
}

// Generates an LLM title for a task's raw prompt; returns the fallback on
// any failure (network, timeout, parse) so callers always get a usable title.
export async function requestTaskTitle(
  cfg: LlmConfig,
  prompt: string,
): Promise<string> {
  const fallback = fallbackTaskTitle(prompt);
  try {
    const content = await lightweightChat(cfg, taskTitleSystemPrompt(cfg.systemPromptExtra), taskTitleUserContent(prompt));
    return sanitizeTaskTitle(content, fallback);
  } catch {
    return fallback;
  }
}
