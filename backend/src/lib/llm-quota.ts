// Rate-limit / quota surfacing for the console footer.
//
// Providers volunteer quota data in response headers; nothing here is ever
// required for a call to succeed. The LLM clients pass every response's
// headers through parseRateLimitHeaders (via onResponseHeaders); the last
// parsed snapshot per LLM config is stored in Redis (best-effort, 1h TTL)
// and read back by GET /api/llm-configs/:id/quota. A provider that sends
// nothing simply has no snapshot — the footer shows "n/a" and never blocks.
//
// Window mapping (see docs/llm-config.md):
//   Anthropic  anthropic-ratelimit-unified-5h-*  → shortWindow ('5-hour')
//              anthropic-ratelimit-unified-7d-*  → weekly
//              anthropic-ratelimit-tokens-*      → shortWindow fallback
//   OpenAI et al. (z.ai, Kimi, Grok — OpenAI-compatible)
//              x-ratelimit-*-tokens              → shortWindow ('per-minute')
//              (no literal 5h/weekly quota exists; the label says so)

import type { LlmApiPattern } from './llm-providers.js';
import { getRedisClient } from './redis.js';

export interface QuotaWindow {
  /** Display label: '5-hour', 'weekly', 'per-minute (tokens)', … */
  label: string;
  limit: number | null;
  remaining: number | null;
  /** ISO reset timestamp; null when the provider does not state one. */
  resetsAt: string | null;
}

export interface LlmQuotaInfo {
  pattern: LlmApiPattern;
  /** ISO timestamp of the response these numbers came from. */
  capturedAt: string;
  shortWindow: QuotaWindow | null;
  weekly: QuotaWindow | null;
}

const REDIS_KEY_PREFIX = 'llm-quota:';
const REDIS_TTL_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Header parsing (pure)
// ---------------------------------------------------------------------------

function headerInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function headerResetIso(headers: Headers, name: string): string | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** OpenAI reset durations: '120ms', '1.5s', '6m0s', '1h2m3s'. */
export function parseResetDurationMs(raw: string): number | null {
  if (!raw.trim()) return null;
  const parts = raw.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g);
  let total = 0;
  let matched = false;
  for (const part of parts) {
    matched = true;
    const value = Number(part[1]);
    const unit = part[2];
    total += value * (unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000);
  }
  return matched ? Math.round(total) : null;
}

function hasAny(headers: Headers, names: string[]): boolean {
  return names.some((name) => headers.get(name) !== null);
}

function anthropicWindow(headers: Headers, prefix: string, label: string): QuotaWindow | null {
  const limitName = `${prefix}-limit`;
  const remainingName = `${prefix}-remaining`;
  const resetName = `${prefix}-reset`;
  if (!hasAny(headers, [limitName, remainingName, resetName])) return null;
  return {
    label,
    limit: headerInt(headers, limitName),
    remaining: headerInt(headers, remainingName),
    resetsAt: headerResetIso(headers, resetName),
  };
}

function parseAnthropic(headers: Headers): LlmQuotaInfo | null {
  const shortWindow =
    anthropicWindow(headers, 'anthropic-ratelimit-unified-5h', '5-hour') ??
    anthropicWindow(headers, 'anthropic-ratelimit-tokens', 'tokens window') ??
    anthropicWindow(headers, 'anthropic-ratelimit-requests', 'requests window');
  const weekly = anthropicWindow(headers, 'anthropic-ratelimit-unified-7d', 'weekly');
  if (!shortWindow && !weekly) return null;
  return { pattern: 'anthropic', capturedAt: new Date().toISOString(), shortWindow, weekly };
}

function openAiWindow(
  headers: Headers,
  kind: 'tokens' | 'requests',
  now: number,
): QuotaWindow | null {
  const prefix = `x-ratelimit-${kind === 'tokens' ? 'limit-tokens' : 'limit-requests'}`;
  const remainingName = `x-ratelimit-remaining-${kind}`;
  const resetName = `x-ratelimit-reset-${kind}`;
  if (!hasAny(headers, [prefix, remainingName, resetName])) return null;
  const resetMs = parseResetDurationMs(headers.get(resetName) ?? '');
  return {
    label: `per-minute (${kind})`,
    limit: headerInt(headers, prefix),
    remaining: headerInt(headers, remainingName),
    resetsAt: resetMs === null ? null : new Date(now + resetMs).toISOString(),
  };
}

function parseOpenAi(headers: Headers): LlmQuotaInfo | null {
  const now = Date.now();
  const shortWindow =
    openAiWindow(headers, 'tokens', now) ?? openAiWindow(headers, 'requests', now);
  if (!shortWindow) return null;
  return { pattern: 'openai', capturedAt: new Date(now).toISOString(), shortWindow, weekly: null };
}

/** Parse one response's headers into quota info; null when nothing usable. */
export function parseRateLimitHeaders(
  pattern: LlmApiPattern,
  headers: Headers,
): LlmQuotaInfo | null {
  return pattern === 'anthropic' ? parseAnthropic(headers) : parseOpenAi(headers);
}

// ---------------------------------------------------------------------------
// Redis snapshot storage (best-effort)
// ---------------------------------------------------------------------------

export function serializeQuota(info: LlmQuotaInfo): string {
  return JSON.stringify(info);
}

export function deserializeQuota(raw: string): LlmQuotaInfo | null {
  try {
    const parsed = JSON.parse(raw) as LlmQuotaInfo;
    if (parsed?.pattern !== 'openai' && parsed?.pattern !== 'anthropic') return null;
    if (typeof parsed.capturedAt !== 'string') return null;
    return {
      pattern: parsed.pattern,
      capturedAt: parsed.capturedAt,
      shortWindow: parsed.shortWindow ?? null,
      weekly: parsed.weekly ?? null,
    };
  } catch {
    return null;
  }
}

/** Store the latest quota snapshot for a config; failures are swallowed. */
export async function recordLlmQuota(configId: string, info: LlmQuotaInfo): Promise<void> {
  try {
    await getRedisClient().set(
      `${REDIS_KEY_PREFIX}${configId}`,
      serializeQuota(info),
      'EX',
      REDIS_TTL_SECONDS,
    );
  } catch {
    // Quota display is advisory — never let storage break an LLM call.
  }
}

/** Latest stored quota snapshot for a config; null when none/expired/down. */
export async function readLlmQuota(configId: string): Promise<LlmQuotaInfo | null> {
  try {
    const raw = await getRedisClient().get(`${REDIS_KEY_PREFIX}${configId}`);
    return raw ? deserializeQuota(raw) : null;
  } catch {
    return null;
  }
}

/** Build the onResponseHeaders hook that snapshots quota for a config. */
export function quotaHeaderRecorder(
  pattern: LlmApiPattern,
  configId: string | undefined,
): ((headers: Headers) => void) | undefined {
  if (!configId) return undefined;
  return (headers: Headers) => {
    const info = parseRateLimitHeaders(pattern, headers);
    if (info) void recordLlmQuota(configId, info);
  };
}
