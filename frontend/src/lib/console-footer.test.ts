import { describe, expect, it } from 'vitest';

import {
  contextUsageLabel,
  contextUsageLevel,
  quotaLines,
  quotaWindowLabel,
  resetCountdownLabel,
} from '@/lib/console-footer';
import type { LlmQuotaInfo, QuotaWindow } from '@/lib/hooks';

// Locking tests for the console footer helpers: the session context indicator
// thresholds (green <60%, amber 60–85%, red >85%) and the rate-limit window
// labels (5-hour / weekly / per-minute fallbacks, "n/a" on missing data).

const NOW = Date.parse('2026-07-27T12:00:00Z');

describe('contextUsageLevel', () => {
  it('is ok below 60% of the context window', () => {
    expect(contextUsageLevel(59_999, 100_000)).toBe('ok');
  });

  it('is warning from 60% up to 85%', () => {
    expect(contextUsageLevel(60_000, 100_000)).toBe('warning');
    expect(contextUsageLevel(85_000, 100_000)).toBe('warning');
  });

  it('is critical above 85%', () => {
    expect(contextUsageLevel(85_001, 100_000)).toBe('critical');
  });

  it('never divides by a zero/negative window', () => {
    expect(contextUsageLevel(1, 0)).toBe('ok');
  });
});

describe('contextUsageLabel', () => {
  it('formats used vs window with compact token counts', () => {
    expect(contextUsageLabel(48_200, 200_000)).toBe('48.2k / 200k tokens');
    expect(contextUsageLabel(800, 128_000)).toBe('800 / 128k tokens');
  });
});

describe('resetCountdownLabel', () => {
  it('renders minutes under an hour', () => {
    expect(resetCountdownLabel('2026-07-27T12:45:00Z', NOW)).toBe('resets in 45m');
  });

  it('renders hours and minutes under a day', () => {
    expect(resetCountdownLabel('2026-07-27T14:05:00Z', NOW)).toBe('resets in 2h 5m');
    expect(resetCountdownLabel('2026-07-27T17:00:00Z', NOW)).toBe('resets in 5h');
  });

  it('renders days for the weekly window', () => {
    expect(resetCountdownLabel('2026-07-30T15:00:00Z', NOW)).toBe('resets in 3d 3h');
  });

  it('is null for missing, malformed, or past reset times', () => {
    expect(resetCountdownLabel(null, NOW)).toBeNull();
    expect(resetCountdownLabel('not-a-date', NOW)).toBeNull();
    expect(resetCountdownLabel('2026-07-27T11:00:00Z', NOW)).toBeNull();
  });
});

describe('quotaWindowLabel', () => {
  const full: QuotaWindow = {
    label: '5-hour',
    limit: 100_000,
    remaining: 42_000,
    resetsAt: '2026-07-27T17:00:00Z',
  };

  it('renders remaining/limit and the reset countdown', () => {
    expect(quotaWindowLabel(full, NOW)).toBe('5-hour: 42,000/100,000 left · resets in 5h');
  });

  it('omits the limit and reset when the provider did not send them', () => {
    expect(quotaWindowLabel({ label: 'per-minute (tokens)', limit: null, remaining: 900, resetsAt: null }, NOW)).toBe(
      'per-minute (tokens): 900 left',
    );
  });

  it('renders n/a for a window without a remaining count', () => {
    expect(quotaWindowLabel({ label: 'weekly', limit: null, remaining: null, resetsAt: null }, NOW)).toBe(
      'weekly: n/a',
    );
  });

  it('is null for an absent window', () => {
    expect(quotaWindowLabel(null, NOW)).toBeNull();
  });
});

describe('quotaLines', () => {
  it('joins the short and weekly windows, skipping absent ones', () => {
    const quota: LlmQuotaInfo = {
      pattern: 'anthropic',
      capturedAt: '2026-07-27T11:59:00Z',
      shortWindow: { label: '5-hour', limit: null, remaining: 1000, resetsAt: null },
      weekly: { label: 'weekly', limit: null, remaining: 50_000, resetsAt: null },
    };
    expect(quotaLines(quota, NOW)).toEqual(['5-hour: 1,000 left', 'weekly: 50,000 left']);
  });

  it('is empty when no snapshot exists (provider exposes nothing)', () => {
    expect(quotaLines(null, NOW)).toEqual([]);
    expect(quotaLines(undefined, NOW)).toEqual([]);
  });
});
