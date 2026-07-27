import { describe, expect, it } from 'vitest';
import { LlmError } from '../src/lib/llm-client.js';
import { rateLimitDeferMs } from '../src/lib/llm-rate-limit.js';

// rateLimitDeferMs decides how long a job parks itself after an LLM
// rate-limit failure: provider-stated reset time when parseable (clamped),
// a flat hour otherwise, and null for non-rate-limit errors so callers fall
// back to normal retry handling.

const NOW = Date.parse('2026-07-27T09:00:00Z');

describe('rateLimitDeferMs', () => {
  it('returns null for non-rate-limit errors', () => {
    expect(rateLimitDeferMs(new Error('boom'), NOW)).toBeNull();
    expect(rateLimitDeferMs(new LlmError('http', 'HTTP 500: internal', 500), NOW)).toBeNull();
    expect(rateLimitDeferMs(new LlmError('timeout', 'timed out'), NOW)).toBeNull();
    expect(rateLimitDeferMs('not an error', NOW)).toBeNull();
  });

  it('detects 429 by status and by message', () => {
    expect(rateLimitDeferMs(new LlmError('http', 'HTTP 429', 429), NOW)).toBe(60 * 60_000);
    expect(rateLimitDeferMs(new Error('RateLimitError: rate limit exceeded'), NOW)).toBe(
      60 * 60_000,
    );
    expect(rateLimitDeferMs(new Error('usage limit reached'), NOW)).toBe(60 * 60_000);
  });

  it('uses the provider reset time when parseable', () => {
    const err = new LlmError(
      'http',
      'HTTP 429: {"error":{"message":"Usage limit reached. Your limit will reset at 2026-07-27 11:00:00"}}',
      429,
    );
    const expected = Date.parse('2026-07-27T11:00:00Z') + 5 * 60_000 - NOW;
    expect(rateLimitDeferMs(err, NOW)).toBe(expected);
  });

  it('clamps the parsed reset to [10min, 6h]', () => {
    const soon = new Error('rate limit, reset at 2026-07-27 09:02:00');
    expect(rateLimitDeferMs(soon, NOW)).toBe(10 * 60_000);
    const far = new Error('usage limit reached, reset at 2026-07-28 09:00:00');
    expect(rateLimitDeferMs(far, NOW)).toBe(6 * 60 * 60_000);
  });

  it('falls back to a flat hour when the reset time is past or malformed', () => {
    const past = new Error('usage limit reached, reset at 2026-07-27 08:00:00');
    expect(rateLimitDeferMs(past, NOW)).toBe(60 * 60_000);
    const garbage = new Error('usage limit reached, reset at not-a-date');
    expect(rateLimitDeferMs(garbage, NOW)).toBe(60 * 60_000);
  });
});
