import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ chatCompletions: vi.fn(), logEvent: vi.fn() }));

vi.mock('../src/lib/llm-client.js', () => ({ chatCompletions: mocks.chatCompletions }));
vi.mock('../src/lib/agent-git.js', () => ({ logEvent: mocks.logEvent }));

import {
  assertWithinBudget,
  billedTokens,
  llmCall,
  minCallIntervalMs,
  parseCustomHeaders,
  sumMessageChars,
  throttleDelayMs,
  TokenBudgetExceededError,
  type LlmRuntime,
} from '../src/lib/agent-runtime.js';

// Locking tests for the LLM runtime primitives extracted from agent-loop.ts:
// the requestsPerMinute throttle, the token-budget accounting (with the
// chars/4 fallback), and the customHeaders lenient parsing.

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logEvent.mockResolvedValue(undefined);
  mocks.chatCompletions.mockResolvedValue({
    content: 'ok',
    model: 'model-x',
    usage: { promptTokens: 10, completionTokens: 32, totalTokens: 42 },
    latencyMs: 2300,
  });
});

function stubRuntime(taskId?: string): LlmRuntime {
  return {
    cfg: {
      baseUrl: 'https://llm.example',
      model: 'model-x',
      temperature: 0.2,
      maxTokens: 1000,
      thinkingLevel: 'off',
      timeoutSeconds: 30,
      maxRetries: 3,
      requestsPerMinute: 60_000,
      maxTokensPerRun: null,
      customHeaders: null,
    },
    apiKey: 'key',
    usedTokens: 0,
    lastCallStartedAt: 0,
    ...(taskId ? { taskId } : {}),
  } as unknown as LlmRuntime;
}

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

describe('sumMessageChars', () => {
  it('sums plain string contents', () => {
    expect(
      sumMessageChars([
        { role: 'system', content: 'abcd' },
        { role: 'user', content: 'ef' },
      ]),
    ).toBe(6);
  });

  it('sums text parts and image url lengths for multimodal content', () => {
    expect(
      sumMessageChars([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ]),
    ).toBe(5 + 'data:image/png;base64,AAA'.length);
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

describe('llmCall console logging', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }];

  it('logs the call start and completion with latency and tokens', async () => {
    await llmCall(stubRuntime('task-1'), messages);
    expect(mocks.logEvent).toHaveBeenNthCalledWith(1, 'task-1', '→ LLM call (model-x)');
    expect(mocks.logEvent).toHaveBeenNthCalledWith(2, 'task-1', '← LLM done in 2.3s, ~42 tokens');
  });

  it('stays silent when the runtime has no taskId', async () => {
    await llmCall(stubRuntime(), messages);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('wires chatCompletions onRetry to a retry log line', async () => {
    await llmCall(stubRuntime('task-1'), messages);
    const params = mocks.chatCompletions.mock.calls[0]?.[0];
    params.onRetry({ attempt: 1, maxAttempts: 3, delayMs: 500, reason: 'HTTP 429' });
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      '  LLM retry 1/3 in 500ms (HTTP 429)',
    );
  });
});
