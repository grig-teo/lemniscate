import { LlmError } from './llm-client.js';

// Rate-limit / usage-quota failures (HTTP 429) need a retry horizon of
// minutes to HOURS — the provider's reset window dwarfs BullMQ's 60s
// backoff, so retrying right away just burns attempts and strands the task.
// Jobs that can defer (review-pr today) use rateLimitDeferMs to decide how
// long to wait before re-enqueueing themselves.

const MIN_DEFER_MS = 10 * 60_000;
const MAX_DEFER_MS = 6 * 60 * 60_000;
const DEFAULT_DEFER_MS = 60 * 60_000;
// Small buffer past the provider's stated reset so we don't land one second
// early and 429 again.
const RESET_BUFFER_MS = 5 * 60_000;

const RATE_LIMIT_MESSAGE =
  /rate.?limit|usage limit|http 429|insufficient.?quota|resource.?exhausted|quota exceeded/i;
// z.ai-style quota message: "Your limit will reset at 2026-07-27 19:07:44".
const RESET_AT = /reset at (\d{4}-\d{2}-\d{2})[ t](\d{2}:\d{2}:\d{2})/i;

// The single rate-limit/quota classifier across providers (AGENTS.md §6):
// HTTP 429 by status, plus the body signatures OpenAI ('insufficient_quota'),
// Gemini ('RESOURCE_EXHAUSTED') and OpenAI-compatible gateways volunteer.
// Only errors passing this check may park a config (llm-exhaustion.ts) — a
// persistent failure caused by a malformed request must never trigger
// pointless model switching.
export function isRateLimited(err: unknown): boolean {
  if (err instanceof LlmError) {
    return err.status === 429 || RATE_LIMIT_MESSAGE.test(err.message);
  }
  return err instanceof Error && RATE_LIMIT_MESSAGE.test(err.message);
}

// Milliseconds to wait before retrying after a rate-limit failure, or null
// when the error is not a rate limit. Prefers the provider's stated reset
// time (clamped to [10min, 6h]); falls back to `defaultMs` (a flat hour
// unless the caller overrides — llm-exhaustion.ts passes the configured
// cooldown) when the message carries no parseable timestamp.
export function rateLimitDeferMs(
  err: unknown,
  now = Date.now(),
  defaultMs = DEFAULT_DEFER_MS,
): number | null {
  if (!isRateLimited(err)) return null;
  const message = err instanceof Error ? err.message : String(err);
  const match = RESET_AT.exec(message);
  if (match) {
    // Provider timestamps have no zone — treat as UTC (z.ai behavior).
    const resetAt = Date.parse(`${match[1]}T${match[2]}Z`);
    if (!Number.isNaN(resetAt)) {
      const delay = resetAt + RESET_BUFFER_MS - now;
      if (delay > 0) return Math.min(Math.max(delay, MIN_DEFER_MS), MAX_DEFER_MS);
    }
  }
  return defaultMs;
}
