import type { LlmConfig } from '@prisma/client';
import { z } from 'zod';
import { logEvent } from './agent-git.js';
import { decrypt } from './crypto.js';
import {
  LlmError,
  type ChatCompletionsParams,
  type ChatMessage,
  type LlmRetryInfo,
} from './llm-client.js';
import { prisma } from './prisma.js';
import { assertPublicHttpUrl } from './url-safety.js';
import { assertSafeLlmBaseUrl } from './agent-runtime-gates.js';
import type { LlmRuntime } from './agent-runtime.js';

// The LLM call wrapper, extracted from agent-runtime.ts:
//   1. Per-call plumbing — chatParams (runtime → request params) and the
//      task-console start/done/retry log lines.
//   2. Cross-config failover — when the active config's endpoint fails
//      (unreachable, quota/tokens exhausted, timeouts, broken responses),
//      llmCallWithFailover promotes the user's next enabled config and the
//      call continues there instead of aborting the run. Only LlmError
//      triggers failover: a TokenBudgetExceededError is a deliberate local
//      cap, and switching providers must not reset it.

// ---------------------------------------------------------------------------
// Per-call params + console logging (moved from agent-runtime.ts)
// ---------------------------------------------------------------------------

const customHeadersSchema = z.record(z.string());

// Stored customHeaders are Json in the DB; anything malformed degrades to {}.
export function parseCustomHeaders(raw: unknown): Record<string, string> {
  const parsed = customHeadersSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

function logLlmRetry(taskId: string, info: LlmRetryInfo): void {
  const line = `  LLM retry ${info.attempt}/${info.maxAttempts} in ${info.delayMs}ms (${info.reason})`;
  void logEvent(taskId, line).catch(() => {});
}

export function chatParams(rt: LlmRuntime, messages: ChatMessage[]): ChatCompletionsParams {
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

export async function logLlmStart(rt: LlmRuntime): Promise<void> {
  if (!rt.taskId) return;
  await logEvent(rt.taskId, `→ LLM call (${rt.cfg.model})`).catch(() => {});
}

export async function logLlmDone(rt: LlmRuntime, latencyMs: number, billed: number): Promise<void> {
  if (!rt.taskId) return;
  await logEvent(rt.taskId, `← LLM done in ${(latencyMs / 1000).toFixed(1)}s, ~${billed} tokens`)
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Failover chain
// ---------------------------------------------------------------------------

const FAILOVER_REASON_MAX_CHARS = 200;

// Candidates for taking over a failed call: the user's other enabled configs,
// default first — the same precedence findUserFallback (agent-runtime.ts)
// uses when picking the primary config.
export async function findFailoverConfigs(
  userId: string,
  excludeIds: string[],
): Promise<LlmConfig[]> {
  return prisma.llmConfig.findMany({
    where: { userId, enabled: true, id: { notIn: excludeIds } },
    orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
  });
}

function isFailoverEligible(rt: LlmRuntime, err: unknown): err is LlmError {
  return err instanceof LlmError && typeof rt.userId === 'string';
}

// Rows saved before the SSRF guard could point at private addresses; a
// failover candidate is dialed with a decrypted key, so it gets the same
// baseUrl gate as the primary config (assertSafeLlmBaseUrl in
// agent-runtime.ts) — unsafe candidates are skipped, not dialed.
async function hasSafeBaseUrl(baseUrl: string): Promise<boolean> {
  try {
    await assertPublicHttpUrl(baseUrl);
    return true;
  } catch {
    return false;
  }
}

function truncateReason(message: string): string {
  if (message.length <= FAILOVER_REASON_MAX_CHARS) return message;
  return `${message.slice(0, FAILOVER_REASON_MAX_CHARS)}…`;
}

// Swaps the runtime onto another config: fresh decrypted key (registered on
// the shared scrub list), reset throttle (the new endpoint has its own rpm),
// and a console line recording the switch. Token counters carry over — the
// per-run budget spans all configs used by the run. Shared by the failover
// chain and the mid-run model switch (agent-runtime.ts).
export function switchRuntimeConfig(rt: LlmRuntime, cfg: LlmConfig, logLine: string): void {
  const apiKey = decrypt(cfg.apiKeyEnc);
  rt.secrets?.push(apiKey);
  rt.cfg = cfg;
  rt.apiKey = apiKey;
  rt.lastCallStartedAt = 0;
  if (rt.taskId) void logEvent(rt.taskId, logLine).catch(() => {});
}

function logFailover(rt: LlmRuntime, fromModel: string, cfg: LlmConfig, cause: LlmError): string {
  return (
    `⚠ LLM failover: ${fromModel} failed (${truncateReason(cause.message)})` +
    ` — switching to ${cfg.model} [${cfg.name}]`
  );
}

function activateFailoverConfig(rt: LlmRuntime, cfg: LlmConfig, cause: LlmError): void {
  switchRuntimeConfig(rt, cfg, logFailover(rt, rt.cfg.model, cfg, cause));
}

// Persisting the promoted config id to the task row keeps
// applyPendingModelSwitch from reading the pre-failover id as a pending user
// switch and bouncing the runtime back onto the config that just failed.
// Advisory: a failed update must not break an in-flight run.
async function persistPromotedConfig(taskId: string, cfg: LlmConfig): Promise<void> {
  await prisma.task
    .update({ where: { id: taskId }, data: { llmConfigId: cfg.id } })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Mid-run model switch (POST /tasks/:id/model)
// ---------------------------------------------------------------------------

// The user picked another config while this run is in flight. The in-flight
// request already finished (this runs BETWEEN calls); the conversation
// history is preserved in `messages` and re-sent under the new config —
// possibly translated across patterns by llm-dispatch. Advisory: any lookup
// failure keeps the current config rather than breaking the run.
export async function applyPendingModelSwitch(rt: LlmRuntime): Promise<void> {
  if (!rt.taskId || !rt.userId) return;
  try {
    const task = await prisma.task.findUnique({
      where: { id: rt.taskId },
      select: { llmConfigId: true },
    });
    if (!task?.llmConfigId || task.llmConfigId === rt.cfg.id) return;
    const next = await prisma.llmConfig.findFirst({
      where: { id: task.llmConfigId, userId: rt.userId, enabled: true },
    });
    if (!next) return;
    await assertSafeLlmBaseUrl(next.baseUrl);
    const line = `⇄ model switched to ${next.model} [${next.name}] — continuing task`;
    switchRuntimeConfig(rt, next, line);
  } catch {
    // Never let switch bookkeeping break an in-flight run.
  }
}

// Marks the active config as failed and promotes the next enabled candidate.
// Returns false when nothing usable remains — the caller rethrows the
// original error so the run fails with the primary cause, not a failover
// bookkeeping message.
export async function promoteFailoverConfig(rt: LlmRuntime, cause: LlmError): Promise<boolean> {
  if (!rt.userId) return false;
  const tried = (rt.triedConfigIds ??= []);
  tried.push(rt.cfg.id);
  const candidates = await findFailoverConfigs(rt.userId, tried);
  for (const candidate of candidates) {
    if (!(await hasSafeBaseUrl(candidate.baseUrl))) {
      tried.push(candidate.id);
      continue;
    }
    activateFailoverConfig(rt, candidate, cause);
    if (rt.taskId) await persistPromotedConfig(rt.taskId, candidate);
    return true;
  }
  return false;
}

// Runs callOnce against the active config; on an LlmError, walks the failover
// chain (each failed config is tried at most once per run) until one config
// answers or the chain is exhausted.
export async function llmCallWithFailover(
  rt: LlmRuntime,
  messages: ChatMessage[],
  callOnce: (rt: LlmRuntime, messages: ChatMessage[]) => Promise<string>,
): Promise<string> {
  for (;;) {
    try {
      return await callOnce(rt, messages);
    } catch (err) {
      if (!isFailoverEligible(rt, err)) throw err;
      if (!(await promoteFailoverConfig(rt, err))) throw err;
    }
  }
}
