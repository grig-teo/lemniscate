import { describe, expect, it } from 'vitest';
import {
  assertWithinBudget,
  billedTokens,
  minCallIntervalMs,
  parseCustomHeaders,
  throttleDelayMs,
  TokenBudgetExceededError,
} from '../src/lib/agent-runtime.js';

// Locking tests for the LLM runtime primitives extracted from agent-loop.ts:
// the requestsPerMinute throttle, the token-budget accounting (with the
// chars/4 fallback), and the customHeaders lenient parsing.

describe('minCallIntervalMs', () => {
  it('spreads requests evenly across a minute', () => {
    expect(minCallIntervalMs(60)).toBe(1000);
    expect(minCallIntervalMs(7)).toBe(Math.ceil(60_000 / 7));
  });

  it('treats non-positive rates as 1 rpm', () => {
    expect(minCallIntervalMs(0)).toBe(60_000);
  });
});

describe('throttleDelayMs', () => {
  it('does not throttle the very first call', () => {
    expect(throttleDelayMs(0, 1000, 500)).toBe(0);
  });

  it('waits out the remainder of the interval', () => {
    expect(throttleDelayMs(1000, 1000, 1400)).toBe(600);
  });

  it('does not wait once the interval has elapsed', () => {
    expect(throttleDelayMs(1000, 1000, 2000)).toBe(0);
  });
});

describe('billedTokens', () => {
  it('prefers the usage reported by the endpoint', () => {
    expect(billedTokens(400, 400, 123)).toBe(123);
  });

  it('falls back to the chars/4 heuristic, rounded up', () => {
    expect(billedTokens(300, 101, undefined)).toBe(Math.ceil(401 / 4));
  });
});

describe('assertWithinBudget', () => {
  it('passes at exactly the limit and when unlimited', () => {
    expect(() => assertWithinBudget(100, 100)).not.toThrow();
    expect(() => assertWithinBudget(10_000, null)).not.toThrow();
  });

  it('throws TokenBudgetExceededError over the limit', () => {
    expect(() => assertWithinBudget(101, 100)).toThrow(TokenBudgetExceededError);
    expect(() => assertWithinBudget(101, 100)).toThrow(
      'LLM token budget exceeded (101 > 100 tokens); aborting run',
    );
  });
});

describe('parseCustomHeaders', () => {
  it('passes through a valid record', () => {
    expect(parseCustomHeaders({ 'x-a': '1' })).toEqual({ 'x-a': '1' });
  });

  it('falls back to {} for malformed stored values', () => {
    expect(parseCustomHeaders(null)).toEqual({});
    expect(parseCustomHeaders({ 'x-a': 5 })).toEqual({});
  });
});
