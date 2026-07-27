// Backoff/timeout policy for the OpenAI-compatible chat client, split out
// of llm-client.ts (AGENTS.md §2 file-size limit). Pure functions, no state;
// llm-client.ts re-exports both so existing importers (tests included) keep
// their import path.

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const MAX_ATTEMPT_TIMEOUT_SECONDS = 600;

// Exported for unit tests. Large-context calls on slow endpoints regularly
// outlast the base timeout; retrying with the same timeout would just fail
// the same way, so every attempt gets twice the room of the previous one.
export function timeoutForAttemptSeconds(baseTimeoutSeconds: number, attempt: number): number {
  return Math.min(baseTimeoutSeconds * 2 ** attempt, MAX_ATTEMPT_TIMEOUT_SECONDS);
}

// Exported for unit tests.
export function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, BACKOFF_MAX_MS);
    }
  }
  const exponential = BACKOFF_BASE_MS * 2 ** attempt;
  const jitter = Math.random() * BACKOFF_BASE_MS;
  return Math.min(exponential + jitter, BACKOFF_MAX_MS);
}
