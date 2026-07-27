import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError } from '../src/lib/llm-client.js';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  set: vi.fn(),
  get: vi.fn(),
  mget: vi.fn(),
}));

vi.mock('../src/lib/redis.js', () => ({
  getRedisClient: () => ({ set: mocks.set, get: mocks.get, mget: mocks.mget }),
}));

import {
  exhaustionCooldownMs,
  filterHealthyConfigs,
  markConfigExhausted,
  readConfigExhaustion,
} from '../src/lib/llm-exhaustion.js';

// Cross-run exhaustion registry (llm-exhaustion.ts): when a config's provider
// reports the token/rate limit exhausted, the config is parked in Redis with
// a cooldown so later runs skip it until the limit resets; TTL expiry is the
// automatic recovery. Everything is best-effort — a Redis outage must never
// break an LLM call.

const NOW = Date.parse('2026-07-27T09:00:00Z');

beforeEach(() => {
  mocks.store.clear();
  vi.clearAllMocks();
  mocks.set.mockImplementation((key: string, value: string) => {
    mocks.store.set(key, value);
    return Promise.resolve('OK');
  });
  mocks.get.mockImplementation((key: string) => Promise.resolve(mocks.store.get(key) ?? null));
  mocks.mget.mockImplementation((...keys: string[]) =>
    Promise.resolve(keys.map((key) => mocks.store.get(key) ?? null)),
  );
});

describe('exhaustionCooldownMs', () => {
  it('returns null for non-rate-limit errors (only quota signals park a config)', () => {
    expect(exhaustionCooldownMs(new Error('boom'), NOW)).toBeNull();
    expect(exhaustionCooldownMs(new LlmError('http', 'HTTP 500', 500), NOW)).toBeNull();
    expect(exhaustionCooldownMs(new LlmError('timeout', 'timed out'), NOW)).toBeNull();
  });

  it('uses the configured default when the provider states no reset time', () => {
    // LLM_EXHAUSTION_COOLDOWN_MS schema default: one hour.
    expect(exhaustionCooldownMs(new LlmError('http', 'HTTP 429', 429), NOW)).toBe(60 * 60_000);
  });

  it('honors the provider-stated reset time (clamped)', () => {
    const err = new LlmError(
      'http',
      'HTTP 429: {"error":{"message":"Usage limit reached. Your limit will reset at 2026-07-27 11:00:00"}}',
      429,
    );
    expect(exhaustionCooldownMs(err, NOW)).toBe(
      Date.parse('2026-07-27T11:00:00Z') + 5 * 60_000 - NOW,
    );
  });
});

describe('markConfigExhausted / readConfigExhaustion', () => {
  it('stores the record with a PX TTL equal to the cooldown', async () => {
    await markConfigExhausted('A', 60_000, 'HTTP 429: rate limited');
    expect(mocks.set).toHaveBeenCalledWith(
      'llm-exhausted:A',
      expect.stringContaining('"reason":"HTTP 429: rate limited"'),
      'PX',
      60_000,
    );
    const record = await readConfigExhaustion('A');
    expect(record?.reason).toBe('HTTP 429: rate limited');
    expect(Date.parse(record?.until ?? '')).toBeGreaterThan(Date.now());
  });

  it('returns null when no record exists or the payload is malformed', async () => {
    expect(await readConfigExhaustion('missing')).toBeNull();
    mocks.store.set('llm-exhausted:B', 'not json');
    expect(await readConfigExhaustion('B')).toBeNull();
    mocks.store.set('llm-exhausted:C', JSON.stringify({ until: 42 }));
    expect(await readConfigExhaustion('C')).toBeNull();
  });

  it('swallows Redis failures — parking is advisory and never breaks a call', async () => {
    mocks.set.mockRejectedValue(new Error('redis down'));
    await expect(markConfigExhausted('A', 1000, 'x')).resolves.toBeNull();
    mocks.get.mockRejectedValue(new Error('redis down'));
    await expect(readConfigExhaustion('A')).resolves.toBeNull();
  });
});

describe('filterHealthyConfigs', () => {
  const configs = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];

  it('drops configs with a live exhaustion record, preserving order', async () => {
    await markConfigExhausted('B', 60_000, 'rate limited');
    expect(await filterHealthyConfigs(configs)).toEqual([{ id: 'A' }, { id: 'C' }]);
  });

  it('returns everything when nothing is parked (and for empty input)', async () => {
    expect(await filterHealthyConfigs(configs)).toEqual(configs);
    expect(await filterHealthyConfigs([])).toEqual([]);
  });

  it('treats every config as healthy when Redis is down', async () => {
    mocks.mget.mockRejectedValue(new Error('redis down'));
    expect(await filterHealthyConfigs(configs)).toEqual(configs);
  });
});
