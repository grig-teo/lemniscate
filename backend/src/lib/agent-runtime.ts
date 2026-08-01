import type { GitConnection, LlmConfig, Repository, Task } from '@prisma/client';
import { logEvent, type GitAuth } from './agent-git.js';
import { resolveLlmAccessToken } from './llm-access-token.js';
import {
  assertRepoPushAccess,
  gitHttpAuthUsername,
  tokenlessCloneUrl,
  type ProviderName,
} from './git-providers.js';
import {
  LlmError,
  type ChatMessage,
  type ChatUsage,
  type ContentPart,
  type ThinkingLevel,
} from './llm-client.js';
import { chatCompletion } from './llm-dispatch.js';
import { apiPatternOf } from './llm-providers.js';
import { quotaHeaderRecorder } from './llm-quota.js';
import {
  applyPendingModelSwitch,
  chatParams,
  llmCallWithFailover,
  logLlmDone,
  logLlmStart,
} from './llm-failover.js';
import { parseTaskThinkingLevel } from './task-attachments.js';
import { prisma } from './prisma.js';
import { withGitlabRefreshRetry } from './token-refresh.js';
import { assertSafeCloneUrl, assertSafeLlmBaseUrl } from './agent-runtime-gates.js';
import { sleep } from './utils.js';
// LLM runtime for the agent loop: per-run state (token usage + throttle
// timestamp) and the `llmCall` wrapper that enforces the configured
// requestsPerMinute throttle and maxTokensPerRun budget.
// Extracted from agent-loop.ts.
export interface LlmRuntime {
  cfg: LlmConfig;
  apiKey: string;
  usedTokens: number;
  /** Cumulative prompt/completion split, persisted on the task for cost estimates. */
  usedPromptTokens: number;
  usedCompletionTokens: number;
  lastCallStartedAt: number;
  /** Per-task override of the config's thinkingLevel (null column = unset). */
  thinkingLevelOverride?: ThinkingLevel;
  /** When set, llmCall echoes start/done/retry lines to the task console. */
  taskId?: string;
  /** Owning user — enables cross-config failover (llm-failover.ts) when set. */
  userId?: string;
  /** Shared scrub list; failover pushes each rotated-in key here. */
  secrets?: string[];
  /** Config ids that already failed this run — never retried. */
  triedConfigIds?: string[];
}
/** Prompt/completion split of billed tokens — the currency of cost estimates. */
export interface TokenSplit {
  promptTokens: number;
  completionTokens: number;
}
export class TokenBudgetExceededError extends Error {
  constructor(used: number, limit: number, message?: string) {
    super(message ?? `LLM token budget exceeded (${used} > ${limit} tokens); aborting run`);
    this.name = 'TokenBudgetExceededError';
  }
}
export function makeLlmRuntime(cfg: LlmConfig, apiKey: string): LlmRuntime {
  return { cfg, apiKey, usedTokens: 0, usedPromptTokens: 0, usedCompletionTokens: 0, lastCallStartedAt: 0, triedConfigIds: [] };
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

// The billed split of one call: the endpoint-reported split when present,
// otherwise the chars/4 heuristic applied per side. Note the reported split
// can sum to less than reportedTotal (e.g. providers that meter reasoning
// tokens separately) — the total stays authoritative for the budget.
export function billedSplit(
  promptChars: number,
  completionChars: number,
  usage: ChatUsage | undefined,
): TokenSplit {
  if (usage) {
    return { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens };
  }
  return {
    promptTokens: Math.ceil(promptChars / 4),
    completionTokens: Math.ceil(completionChars / 4),
  };
}

/** Current cumulative split of a runtime — passed to persistTokenUsage. */
export function tokenSplit(rt: LlmRuntime): TokenSplit {
  return { promptTokens: rt.usedPromptTokens, completionTokens: rt.usedCompletionTokens };
}

// Seeds a resumed runtime's split counters from the task's stored columns;
// null columns (tasks that predate the split) start from zero, so the stored
// split only ever covers tokens billed after the columns existed.
export function taskTokenSplit(
  task: { llmPromptTokens: number | null; llmCompletionTokens: number | null } | null,
): TokenSplit {
  return {
    promptTokens: task?.llmPromptTokens ?? 0,
    completionTokens: task?.llmCompletionTokens ?? 0,
  };
}

export function assertWithinBudget(usedTokens: number, maxTokensPerRun: number | null): void {
  if (maxTokensPerRun != null && usedTokens > maxTokensPerRun) {
    throw new TokenBudgetExceededError(usedTokens, maxTokensPerRun);
  }
}

/** USD cost ceiling: throws when cumulative cost exceeds the config's cap. */
function assertWithinCost(rt: LlmRuntime): void {
  const cap = rt.cfg.maxCostPerRunUsd;
  if (cap == null) return;
  const cost = (rt.usedPromptTokens / 1e6) * (rt.cfg.inputPricePerMillion ?? 0)
    + (rt.usedCompletionTokens / 1e6) * (rt.cfg.outputPricePerMillion ?? 0);
  if (cost > cap) throw new TokenBudgetExceededError(0, 0, `Cost ceiling: $${cost.toFixed(4)} > $${cap}`);
}

function contentChars(content: string | ContentPart[] | null | undefined): number {
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  return content.reduce(
    (sum, part) => sum + (part.type === 'text' ? part.text.length : part.image_url.url.length),
    0,
  );
}

export function sumMessageChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    if (m.role === 'tool') return sum + m.content.length;
    return sum + contentChars(m.content);
  }, 0);
}

// ---------------------------------------------------------------------------
// The call wrapper: one metered attempt + cross-config failover
// ---------------------------------------------------------------------------

function dispatchParams(rt: LlmRuntime, messages: ChatMessage[]) {
  const pattern = apiPatternOf(rt.cfg);
  return {
    ...chatParams(rt, messages),
    apiPattern: pattern,
    onResponseHeaders: quotaHeaderRecorder(pattern, rt.cfg.id),
  };
}

async function attemptLlmCall(rt: LlmRuntime, messages: ChatMessage[]): Promise<string> {
  await applyPendingModelSwitch(rt);
  await logLlmStart(rt);
  const result = await chatCompletion(dispatchParams(rt, messages));
  const promptChars = sumMessageChars(messages);
  const billed = billedTokens(promptChars, result.content.length, result.usage?.totalTokens);
  const split = billedSplit(promptChars, result.content.length, result.usage);
  rt.usedTokens += billed;
  rt.usedPromptTokens += split.promptTokens;
  rt.usedCompletionTokens += split.completionTokens;
  await logLlmDone(rt, result.latencyMs, billed);
  assertWithinBudget(rt.usedTokens, rt.cfg.maxTokensPerRun);
  assertWithinCost(rt);
  // An empty completion (no content, no tool calls) is a broken reply, not
  // an answer — some providers (z.ai GLM) return finish_reason 'stop' with
  // an empty message once the reasoning budget is consumed. Routing it into
  // the failover chain gives the next config a shot instead of poisoning
  // the caller with blank output.
  if (result.content.trim().length === 0 && !(result.toolCalls && result.toolCalls.length > 0)) {
    throw new LlmError('protocol', 'LLM returned an empty reply (no content, no tool calls)');
  }
  return result.content;
}

// One metered attempt against the active config; when its endpoint fails
// (unreachable, quota/tokens exhausted, timeouts, broken replies) the next
// enabled config of the same user takes over and the call is retried there
// (llm-failover.ts) — a dead provider aborts the run only when no failover
// config remains. The per-run token budget is NOT a failover trigger.
export async function llmCall(rt: LlmRuntime, messages: ChatMessage[]): Promise<string> {
  await throttle(rt);
  return llmCallWithFailover(rt, messages, attemptLlmCall);
}

// Shared job context: task loading + credential/runtime preparation
// Re-exported so existing consumers (routes, tests) keep importing the
// resolution surface from agent-runtime; implementation lives in
// llm-config-resolution.ts (split to keep this module under the line guard).
export { findLlmConfig, resolveLlmConfig } from './llm-config-resolution.js';
import { resolveLlmConfig } from './llm-config-resolution.js';

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

// Decrypts the connection token + LLM key (recording both as secrets to
// scrub from any output) and builds the LLM runtime for a job. Shared by
// run-task, review-pr, and generate-proposals. `llmConfigIdOverride` (e.g.
// the repository's review LLM for the review-pr job) is resolved BEFORE
// task.llmConfigId; when it is set-but-broken the chain continues with
// repo.llmConfigId → user default.
export async function prepareAgentRuntime(
  task: Task | null,
  repository: Repository & { connection: GitConnection },
  secrets: string[],
  usedTokens = 0,
  llmConfigIdOverride: string | null = null,
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
  const username = gitHttpAuthUsername(connection.provider, connection.username);
  const gitAuth: GitAuth = { username, token };
  const llmConfig = await resolveLlmConfig(
    { llmConfigId: llmConfigIdOverride ?? task?.llmConfigId ?? null },
    repository,
    repository.connection.userId,
  );
  await assertSafeLlmBaseUrl(llmConfig.baseUrl);
  const apiKey = await resolveLlmAccessToken(llmConfig);
  secrets.push(apiKey);
  const rt = makeLlmRuntime(llmConfig, apiKey);
  rt.usedTokens = usedTokens;
  const splitSeed = taskTokenSplit(task);
  rt.usedPromptTokens = splitSeed.promptTokens;
  rt.usedCompletionTokens = splitSeed.completionTokens;
  rt.taskId = task?.id;
  rt.userId = repository.connection.userId;
  rt.secrets = secrets;
  const thinkingLevelOverride = parseTaskThinkingLevel(task?.thinkingLevel);
  if (thinkingLevelOverride) rt.thinkingLevelOverride = thinkingLevelOverride;
  return { cloneUrl, gitAuth, rt } as const;
}
