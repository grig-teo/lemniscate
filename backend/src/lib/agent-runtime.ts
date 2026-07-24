import type { GitConnection, LlmConfig, Repository, Task } from '@prisma/client';
import { z } from 'zod';
import { logEvent, type GitAuth } from './agent-git.js';
import { decrypt } from './crypto.js';
import {
  assertRepoPushAccess,
  GIT_HTTP_AUTH_USERNAME,
  tokenlessCloneUrl,
  type ProviderName,
} from './git-providers.js';
import {
  chatCompletions,
  type ChatCompletionsParams,
  type ChatMessage,
  type ThinkingLevel,
} from './llm-client.js';
import { parseTaskThinkingLevel } from './task-attachments.js';
import { prisma } from './prisma.js';
import { withGitlabRefreshRetry } from './token-refresh.js';
import { assertPublicHttpUrl } from './url-safety.js';
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
  /** When set, llmCall echoes start/done/retry lines to the task console. */
  taskId?: string;
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

// Retry-hook payload shared with llm-client's chatCompletions onRetry param.
interface LlmRetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

function logLlmRetry(taskId: string, info: LlmRetryInfo): void {
  const line = `  LLM retry ${info.attempt}/${info.maxAttempts} in ${info.delayMs}ms (${info.reason})`;
  void logEvent(taskId, line).catch(() => {});
}

function chatParams(rt: LlmRuntime, messages: ChatMessage[]): ChatCompletionsParams {
  const thinkingLevel = rt.thinkingLevelOverride ?? rt.cfg.thinkingLevel;
  const params: ChatCompletionsParams & { onRetry?: (info: LlmRetryInfo) => void } = {
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
  if (rt.taskId) params.onRetry = (info) => logLlmRetry(rt.taskId as string, info);
  return params;
}

async function logLlmStart(rt: LlmRuntime): Promise<void> {
  if (!rt.taskId) return;
  await logEvent(rt.taskId, `→ LLM call (${rt.cfg.model})`).catch(() => {});
}

async function logLlmDone(rt: LlmRuntime, latencyMs: number, billed: number): Promise<void> {
  if (!rt.taskId) return;
  await logEvent(rt.taskId, `← LLM done in ${(latencyMs / 1000).toFixed(1)}s, ~${billed} tokens`)
    .catch(() => {});
}

export async function llmCall(rt: LlmRuntime, messages: ChatMessage[]): Promise<string> {
  await throttle(rt);
  await logLlmStart(rt);
  const result = await chatCompletions(chatParams(rt, messages));
  const billed = billedTokens(
    sumMessageChars(messages),
    result.content.length,
    result.usage?.totalTokens,
  );
  rt.usedTokens += billed;
  await logLlmDone(rt, result.latencyMs, billed);
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
  /** Tokenless https clone URL — credentials travel via gitAuth instead. */
  cloneUrl: string;
  /** Per-invocation credentials for the worker's own git child processes. */
  gitAuth: GitAuth;
  rt: LlmRuntime;
}

// Clone URL gate: https-only and publicly routable, checked before any token
// is decrypted or any clone runs — a stored cloneUrl must never turn the
// worker into an SSRF client (or read local services via file/http).
async function assertSafeCloneUrl(cloneUrl: string): Promise<void> {
  const url = await assertPublicHttpUrl(cloneUrl);
  if (url.protocol !== 'https:') {
    throw new Error(`repository cloneUrl must use https (got ${url.protocol})`);
  }
}

// LLM endpoint gate: the saved-config baseUrl is asserted once here, at
// runtime construction — not on the per-request hot path in llm-client.ts.
async function assertSafeLlmBaseUrl(baseUrl: string): Promise<void> {
  await assertPublicHttpUrl(baseUrl).catch((err: unknown) => {
    throw new Error(`LLM baseUrl is not allowed: ${(err as Error).message}`);
  });
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
  const connection = repository.connection;
  await assertSafeCloneUrl(repository.cloneUrl);
  // Resolve a valid token (refreshing an expired GitLab OAuth token first,
  // with one refresh+retry on a 401) and fail fast when it cannot push,
  // before cloning and LLM spend.
  const token = await withGitlabRefreshRetry(connection, async (t) => {
    await assertRepoPushAccess(
      connection.provider as ProviderName,
      t,
      repository.fullName,
      connection.baseUrl,
      connection.tokenType === 'oauth' ? 'oauth' : 'pat',
    );
    return t;
  });
  secrets.push(token);
  const cloneUrl = tokenlessCloneUrl(repository.cloneUrl);
  const gitAuth: GitAuth = { username: GIT_HTTP_AUTH_USERNAME, token };
  const llmConfig = await resolveLlmConfig(task, repository, repository.connection.userId);
  await assertSafeLlmBaseUrl(llmConfig.baseUrl);
  const apiKey = decrypt(llmConfig.apiKeyEnc);
  secrets.push(apiKey);
  const rt = makeLlmRuntime(llmConfig, apiKey);
  rt.usedTokens = usedTokens;
  rt.taskId = task?.id;
  const thinkingLevelOverride = parseTaskThinkingLevel(task?.thinkingLevel);
  if (thinkingLevelOverride) rt.thinkingLevelOverride = thinkingLevelOverride;
  return { cloneUrl, gitAuth, rt };
}
