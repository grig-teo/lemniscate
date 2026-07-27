import { describe, expect, it } from 'vitest';
import {
  deserializeQuota,
  parseResetDurationMs,
  parseRateLimitHeaders,
  serializeQuota,
  type LlmQuotaInfo,
} from '../src/lib/llm-quota.js';

// Locking tests for provider rate-limit header parsing. Each provider
// exposes different signals; parsing must never throw and must return null
// when the provider sent nothing usable (the UI then shows "n/a").

function headersOf(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe('parseRateLimitHeaders — anthropic', () => {
  it('maps unified 5h/7d windows to short/weekly', () => {
    const info = parseRateLimitHeaders(
      'anthropic',
      headersOf({
        'anthropic-ratelimit-unified-5h-limit': '100',
        'anthropic-ratelimit-unified-5h-remaining': '62',
        'anthropic-ratelimit-unified-5h-reset': '2026-07-27T17:00:00Z',
        'anthropic-ratelimit-unified-7d-limit': '1000',
        'anthropic-ratelimit-unified-7d-remaining': '480',
        'anthropic-ratelimit-unified-7d-reset': '2026-08-01T00:00:00Z',
      }),
    );
    expect(info?.pattern).toBe('anthropic');
    expect(info?.shortWindow).toEqual({
      label: '5-hour',
      limit: 100,
      remaining: 62,
      resetsAt: '2026-07-27T17:00:00.000Z',
    });
    expect(info?.weekly).toEqual({
      label: 'weekly',
      limit: 1000,
      remaining: 480,
      resetsAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('falls back to the classic token window as the short window', () => {
    const info = parseRateLimitHeaders(
      'anthropic',
      headersOf({
        'anthropic-ratelimit-tokens-limit': '200000',
        'anthropic-ratelimit-tokens-remaining': '150000',
        'anthropic-ratelimit-tokens-reset': '2026-07-27T13:00:00Z',
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '49',
      }),
    );
    expect(info?.shortWindow?.label).toBe('tokens window');
    expect(info?.shortWindow?.limit).toBe(200000);
    expect(info?.shortWindow?.remaining).toBe(150000);
    expect(info?.weekly).toBeNull();
  });

  it('returns null when no recognizable headers are present', () => {
    expect(parseRateLimitHeaders('anthropic', headersOf({ 'content-type': 'application/json' }))).toBeNull();
    expect(parseRateLimitHeaders('anthropic', headersOf({}))).toBeNull();
  });

  it('tolerates malformed numbers and reset timestamps', () => {
    const info = parseRateLimitHeaders(
      'anthropic',
      headersOf({
        'anthropic-ratelimit-unified-5h-limit': 'soon',
        'anthropic-ratelimit-unified-5h-remaining': '42',
        'anthropic-ratelimit-unified-5h-reset': 'not-a-date',
      }),
    );
    expect(info?.shortWindow?.limit).toBeNull();
    expect(info?.shortWindow?.remaining).toBe(42);
    expect(info?.shortWindow?.resetsAt).toBeNull();
  });
});

describe('parseRateLimitHeaders — openai-compatible', () => {
  it('maps x-ratelimit token headers to the short window with a computed reset', () => {
    const before = Date.now();
    const info = parseRateLimitHeaders(
      'openai',
      headersOf({
        'x-ratelimit-limit-tokens': '90000',
        'x-ratelimit-remaining-tokens': '45000',
        'x-ratelimit-reset-tokens': '6m0s',
      }),
    );
    expect(info?.shortWindow?.label).toBe('per-minute (tokens)');
    expect(info?.shortWindow?.limit).toBe(90000);
    expect(info?.shortWindow?.remaining).toBe(45000);
    const reset = Date.parse(info?.shortWindow?.resetsAt ?? '');
    expect(reset).toBeGreaterThanOrEqual(before + 6 * 60_000);
    expect(reset).toBeLessThanOrEqual(Date.now() + 6 * 60_000);
    expect(info?.weekly).toBeNull();
  });

  it('falls back to the requests window when token headers are absent', () => {
    const info = parseRateLimitHeaders(
      'openai',
      headersOf({
        'x-ratelimit-limit-requests': '500',
        'x-ratelimit-remaining-requests': '499',
        'x-ratelimit-reset-requests': '120ms',
      }),
    );
    expect(info?.shortWindow?.label).toBe('per-minute (requests)');
    expect(info?.shortWindow?.remaining).toBe(499);
  });

  it('returns null when no recognizable headers are present', () => {
    expect(parseRateLimitHeaders('openai', headersOf({ server: 'nginx' }))).toBeNull();
  });
});

describe('parseResetDurationMs', () => {
  it('parses OpenAI-style durations', () => {
    expect(parseResetDurationMs('120ms')).toBe(120);
    expect(parseResetDurationMs('1.5s')).toBe(1500);
    expect(parseResetDurationMs('6m0s')).toBe(360_000);
    expect(parseResetDurationMs('1h2m3s')).toBe(3_723_000);
  });

  it('returns null for unparseable values', () => {
    expect(parseResetDurationMs('')).toBeNull();
    expect(parseResetDurationMs('tomorrow')).toBeNull();
  });
});

describe('serializeQuota/deserializeQuota', () => {
  it('round-trips and rejects garbage', () => {
    const info: LlmQuotaInfo = {
      pattern: 'openai',
      capturedAt: '2026-07-27T12:00:00.000Z',
      shortWindow: { label: 'per-minute (tokens)', limit: 10, remaining: 5, resetsAt: null },
      weekly: null,
    };
    expect(deserializeQuota(serializeQuota(info))).toEqual(info);
    expect(deserializeQuota('not json')).toBeNull();
    expect(deserializeQuota('{"pattern":"nope"}')).toBeNull();
  });
});
