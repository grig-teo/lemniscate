import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ chatCompletions: vi.fn(), logEvent: vi.fn() }));

vi.mock('../src/lib/llm-client.js', () => ({ chatCompletions: mocks.chatCompletions }));
vi.mock('../src/lib/agent-git.js', () => ({ logEvent: mocks.logEvent }));

import {
  billedSplit,
  llmCall,
  makeLlmRuntime,
  taskTokenSplit,
  tokenSplit,
  type LlmRuntime,
} from '../src/lib/agent-runtime.js';

// Tests for the prompt/completion token split threaded through the LLM
// runtime: the endpoint-reported split wins, the chars/4 heuristic splits per
// side as a fallback, and the runtime accumulates both counters for
// persistTokenUsage to store.

function stubRuntime(): LlmRuntime {
  return makeLlmRuntime(
    {
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
    } as never,
    'key',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logEvent.mockResolvedValue(undefined);
});

describe('billedSplit', () => {
  it('prefers the endpoint-reported split', () => {
    expect(
      billedSplit(4000, 400, { promptTokens: 700, completionTokens: 300, totalTokens: 1000 }),
    ).toEqual({ promptTokens: 700, completionTokens: 300 });
  });

  it('falls back to the chars/4 heuristic per side', () => {
    expect(billedSplit(401, 101, undefined)).toEqual({
      promptTokens: Math.ceil(401 / 4),
      completionTokens: Math.ceil(101 / 4),
    });
  });
});

describe('llmCall split accounting', () => {
  it('accumulates the reported prompt/completion split alongside the total', async () => {
    mocks.chatCompletions.mockResolvedValue({
      content: 'ok',
      model: 'model-x',
      usage: { promptTokens: 10, completionTokens: 32, totalTokens: 42 },
      latencyMs: 100,
    });
    const rt = stubRuntime();
    await llmCall(rt, [{ role: 'user', content: 'hi' }]);
    expect(rt.usedTokens).toBe(42);
    expect(rt.usedPromptTokens).toBe(10);
    expect(rt.usedCompletionTokens).toBe(32);
    expect(tokenSplit(rt)).toEqual({ promptTokens: 10, completionTokens: 32 });
  });

  it('splits the heuristic estimate when the endpoint reports no usage', async () => {
    mocks.chatCompletions.mockResolvedValue({
      content: 'abcd',
      model: 'model-x',
      latencyMs: 100,
    });
    const rt = stubRuntime();
    await llmCall(rt, [{ role: 'user', content: '12345678' }]);
    expect(rt.usedPromptTokens).toBe(2);
    expect(rt.usedCompletionTokens).toBe(1);
    expect(rt.usedTokens).toBe(3);
  });
});

describe('taskTokenSplit', () => {
  it('reads the stored split columns', () => {
    expect(taskTokenSplit({ llmPromptTokens: 11, llmCompletionTokens: 22 })).toEqual({
      promptTokens: 11,
      completionTokens: 22,
    });
  });

  it('defaults pre-split rows and null tasks to zero', () => {
    expect(taskTokenSplit({ llmPromptTokens: null, llmCompletionTokens: null })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(taskTokenSplit(null)).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});
