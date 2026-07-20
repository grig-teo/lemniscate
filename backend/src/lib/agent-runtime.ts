import type { GitConnection, LlmConfig, Repository, Task } from '@prisma/client';
import { z } from 'zod';
import { decrypt } from './crypto.js';
import { assertRepoPushAccess, cloneUrlWithToken, type ProviderName } from './git-providers.js';
import { chatCompletions, type ChatMessage, type ThinkingLevel } from './llm-client.js';
import { parseTaskThinkingLevel } from './task-attachments.js';
import { prisma } from './prisma.js';
import { sleep } from './utils.js';

// LLM runtime for the agent loop: per-run state (token usage + throttle
// timestamp) and the `llmCall` wrapper that enforces the configured
// requestsPerMinute throttle and maxTokensPerRun budget.
// Extracted from agent-loop.ts.

export interface LlmRuntime {
  cfg: LlmConfig;
  apiKey: string;
  usedTokens: number;
  lastCallStartedAt: number;
  /** Per-task override of the config's thinkingLevel (null column = unset). */
  thinkingLevelOverride?: ThinkingLevel;
}

export class TokenBudgetExceededError extends Error {
  constructor(used: number, limit: number) {
    super(`LLM token budget exceeded (${used} > ${limit} tokens); aborting run`);
    this.name = 'TokenBudgetExceededError';
  }
}

export function makeLlmRuntime(cfg: LlmConfig, apiKey: string): LlmRuntime {
  return { cfg, apiKey, usedTokens: 0, lastCallStartedAt: 0 };
}

// ---------------------------------------------------------------------------
// Throttle (requestsPerMinute) — a minimum interval between call starts
// ---------------------------------------------------------------------------

export function minCallIntervalMs(requestsPerMinute: number): number {
  return Math.ceil(60_000 / Math.max(1, requestsPerMinute));
}

export function throttleDelayMs(
  lastCallStartedAt: number,
  minIntervalMs: number,
  now: number,
): number {
  if (lastCallStartedAt <= 0) return 0;
  const elapsed = now - lastCallStartedAt;
  return elapsed < minIntervalMs ? minIntervalMs - elapsed : 0;
}

async function throttle(rt: LlmRuntime): Promise<void> {
  const delay = throttleDelayMs(
    rt.lastCallStartedAt,
    minCallIntervalMs(rt.cfg.requestsPerMinute),
    Date.now(),
  );
  if (delay > 0) await sleep(delay);
  rt.lastCallStartedAt = Date.now();
}

// ---------------------------------------------------------------------------
// Token budget (maxTokensPerRun)
// ---------------------------------------------------------------------------

// Tokens to bill for one call: the endpoint-reported total when present,
// otherwise the chars/4 heuristic over prompt + completion.
export function billedTokens(
  promptChars: number,
  completionChars: number,
  reportedTotal: number | undefined,
): number {
  return reportedTotal ?? Math.ceil((promptChars + completionChars) / 4);
}

export function assertWithinBudget(usedTokens: number, maxTokensPerRun: number | null): void {
  if (maxTokensPerRun != null && usedTokens > maxTokensPerRun) {
    throw new TokenBudgetExceededError(usedTokens, maxTokensPerRun);
  }
}

function contentChars(content: ChatMessage['content']): number {
  if (typeof content === 'string') return content.length;
  return content.reduce(
    (sum, part) => sum + (part.type === 'text' ? part.text.length : part.image_url.url.length),
    0,
  );
}

export function sumMessageChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + contentChars(m.content), 0);
}

// ---------------------------------------------------------------------------
// The call wrapper
// ---------------------------------------------------------------------------

const customHeadersSchema = z.record(z.string());

// Stored customHeaders are Json in the DB; anything malformed degrades to {}.
export function parseCustomHeaders(raw: unknown): Record<string, string> {
  const parsed = customHeadersSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

function chatParams(rt: LlmRuntime, messages: ChatMessage[]) {
  const thinkingLevel = rt.thinkingLevelOverride ?? rt.cfg.thinkingLevel;
  return {
    baseUrl: rt.cfg.baseUrl,
    apiKey: rt.apiKey,
    model: rt.cfg.model,
    messages,
    temperature: rt.cfg.temperature,
    maxTokens: rt.cfg.maxTokens,
    ...(thinkingLevel !== 'off' ? { thinkingLevel } : {}),
    timeoutSeconds: rt.cfg.timeoutSeconds,
    maxRetries: rt.cfg.maxRetries,
    customHeaders: parseCustomHeaders(rt.cfg.customHeaders),
  };
}

export async function llmCall(rt: LlmRuntime, messages: ChatMessage[]): Promise<string> {
  await throttle(rt);
  const result = await chatCompletions(chatParams(rt, messages));
  rt.usedTokens += billedTokens(
    sumMessageChars(messages),
    result.content.length,
    result.usage?.totalTokens,
  );
  assertWithinBudget(rt.usedTokens, rt.cfg.maxTokensPerRun);
  return result.content;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

async function findEnabledById(id: string, userId: string): Promise<LlmConfig | null> {
  return prisma.llmConfig.findFirst({ where: { id, userId, enabled: true } });
}

async function findUserFallback(userId: string): Promise<LlmConfig | null> {
  return (
    (await prisma.llmConfig.findFirst({ where: { userId, isDefault: true, enabled: true } })) ??
    (await prisma.llmConfig.findFirst({ where: { userId, enabled: true }, orderBy: { id: 'asc' } }))
  );
}

// Resolution order: task.llmConfigId → repo.llmConfigId → user's default →
// any enabled config of the user.
export async function resolveLlmConfig(
  task: Task | null,
  repository: Repository,
  userId: string,
): Promise<LlmConfig> {
  for (const id of [task?.llmConfigId, repository.llmConfigId]) {
    if (!id) continue;
    const found = await findEnabledById(id, userId);
    if (found) return found;
  }
  const fallback = await findUserFallback(userId);
  if (!fallback) {
    throw new Error(
      'No enabled LLM config found (task override, repository config, and user default are all unset)',
    );
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Shared job context: task loading + credential/runtime preparation
// ---------------------------------------------------------------------------

export type TaskWithRepo = Task & {
  repository: Repository & { connection: GitConnection };
};

export async function loadTaskWithRepo(taskId: string): Promise<TaskWithRepo | null> {
  return (await prisma.task.findUnique({
    where: { id: taskId },
    include: { repository: { include: { connection: true } } },
  })) as TaskWithRepo | null;
}

export interface AgentRunContext {
  cloneUrl: string;
  rt: LlmRuntime;
}

// Decrypts the connection token + LLM key (recording both as secrets to
// scrub from any output) and builds the LLM runtime for a job. Shared by
// run-task, review-pr, and generate-proposals.
export async function prepareAgentRuntime(
  task: Task | null,
  repository: Repository & { connection: GitConnection },
  secrets: string[],
  usedTokens = 0,
): Promise<AgentRunContext> {
  const token = decrypt(repository.connection.accessTokenEnc);
  secrets.push(token);
  // Fail fast when the token cannot push, before cloning and LLM spend.
  await assertRepoPushAccess(
    repository.connection.provider as ProviderName,
    token,
    repository.fullName,
    repository.connection.baseUrl,
    repository.connection.tokenType === 'oauth' ? 'oauth' : 'pat',
  );
  const cloneUrl = cloneUrlWithToken(repository.cloneUrl, token);
  secrets.push(cloneUrl);
  const llmConfig = await resolveLlmConfig(task, repository, repository.connection.userId);
  const apiKey = decrypt(llmConfig.apiKeyEnc);
  secrets.push(apiKey);
  const rt = makeLlmRuntime(llmConfig, apiKey);
  rt.usedTokens = usedTokens;
  const thinkingLevelOverride = parseTaskThinkingLevel(task?.thinkingLevel);
  if (thinkingLevelOverride) rt.thinkingLevelOverride = thinkingLevelOverride;
  return { cloneUrl, rt };
}
