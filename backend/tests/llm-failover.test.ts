import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmConfig } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  chatCompletions: vi.fn(),
  logEvent: vi.fn(),
  findMany: vi.fn(),
  taskUpdate: vi.fn(),
  decrypt: vi.fn(),
  assertPublicHttpUrl: vi.fn(),
}));

vi.mock('../src/lib/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/llm-client.js')>()),
  chatCompletions: mocks.chatCompletions,
}));
vi.mock('../src/lib/agent-git.js', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    llmConfig: { findMany: mocks.findMany },
    task: { update: mocks.taskUpdate },
  },
}));
vi.mock('../src/lib/crypto.js', () => ({ decrypt: mocks.decrypt }));
vi.mock('../src/lib/url-safety.js', () => ({
  assertPublicHttpUrl: mocks.assertPublicHttpUrl,
}));

import { LlmError } from '../src/lib/llm-client.js';
import { llmCall, type LlmRuntime } from '../src/lib/agent-runtime.js';
import { findFailoverConfigs } from '../src/lib/llm-failover.js';

// Cross-config failover: when the active LLM config fails mid-run (endpoint
// down, quota/tokens exhausted, timeouts), llmCall promotes the next enabled
// config of the same user and retries there instead of aborting the run.

function stubConfig(id: string, name: string, model: string, isDefault = false): LlmConfig {
  return {
    id,
    userId: 'user-1',
    name,
    baseUrl: `https://llm-${id}.example`,
    apiKeyEnc: `enc-${id}`,
    model,
    thinkingLevel: 'off',
    temperature: 0.2,
    maxTokens: 1000,
    contextWindow: 128_000,
    systemPromptExtra: null,
    timeoutSeconds: 5,
    maxRetries: 0,
    requestsPerMinute: 60_000,
    maxTokensPerRun: null,
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    customHeaders: {},
    isDefault,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as LlmConfig;
}

function stubRuntime(cfg: LlmConfig, extra: Partial<LlmRuntime> = {}): LlmRuntime {
  return {
    cfg,
    apiKey: 'key-a',
    usedTokens: 0,
    usedPromptTokens: 0,
    usedCompletionTokens: 0,
    lastCallStartedAt: 0,
    userId: 'user-1',
    secrets: [],
    triedConfigIds: [],
    ...extra,
  } as unknown as LlmRuntime;
}

const messages = [{ role: 'user' as const, content: 'hi' }];
const OK_RESULT = {
  content: 'ok',
  model: 'model-b',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logEvent.mockResolvedValue(undefined);
  mocks.decrypt.mockImplementation((enc: string) => `dec:${enc}`);
  mocks.assertPublicHttpUrl.mockResolvedValue(new URL('https://llm.example'));
  mocks.chatCompletions.mockResolvedValue(OK_RESULT);
  mocks.findMany.mockResolvedValue([]);
  mocks.taskUpdate.mockResolvedValue({});
});

describe('findFailoverConfigs', () => {
  it('queries enabled configs of the user excluding tried ids, default first', async () => {
    mocks.findMany.mockResolvedValue([stubConfig('B', 'Backup', 'model-b')]);
    const result = await findFailoverConfigs('user-1', ['A']);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', enabled: true, id: { notIn: ['A'] } },
      orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
    });
    expect(result).toHaveLength(1);
  });
});

describe('llmCall failover', () => {
  it('retries on the next enabled config when the active one fails', async () => {
    const cfgA = stubConfig('A', 'Primary', 'model-a', true);
    const cfgB = stubConfig('B', 'Backup', 'model-b');
    mocks.findMany.mockResolvedValue([cfgB]);
    mocks.chatCompletions
      .mockRejectedValueOnce(new LlmError('http', 'LLM endpoint returned HTTP 402: quota exhausted', 402))
      .mockResolvedValueOnce(OK_RESULT);
    const rt = stubRuntime(cfgA, { taskId: 'task-1' });

    const content = await llmCall(rt, messages);

    expect(content).toBe('ok');
    expect(rt.cfg.id).toBe('B');
    expect(rt.apiKey).toBe('dec:enc-B');
    const secondParams = mocks.chatCompletions.mock.calls[1]?.[0];
    expect(secondParams.baseUrl).toBe('https://llm-B.example');
    expect(secondParams.model).toBe('model-b');
    expect(secondParams.apiKey).toBe('dec:enc-B');
  });

  it('logs the failover switch to the task console', async () => {
    const cfgA = stubConfig('A', 'Primary', 'model-a');
    const cfgB = stubConfig('B', 'Backup', 'model-b');
    mocks.findMany.mockResolvedValue([cfgB]);
    mocks.chatCompletions
      .mockRejectedValueOnce(new LlmError('timeout', 'Request timed out after 5s'))
      .mockResolvedValueOnce(OK_RESULT);
    const rt = stubRuntime(cfgA, { taskId: 'task-1' });

    await llmCall(rt, messages);

    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('model-a'),
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('switching to model-b'),
    );
  });

  it('registers the rotated-in key on the secrets scrub list', async () => {
    const cfgA = stubConfig('A', 'Primary', 'model-a');
    const cfgB = stubConfig('B', 'Backup', 'model-b');
    mocks.findMany.mockResolvedValue([cfgB]);
    mocks.chatCompletions
      .mockRejectedValueOnce(new LlmError('network', 'Network error calling LLM endpoint'))
      .mockResolvedValueOnce(OK_RESULT);
    const rt = stubRuntime(cfgA);

    await llmCall(rt, messages);

    expect(rt.secrets).toContain('dec:enc-B');
  });

  it('does not fail over when the runtime has no userId', async () => {
    const rt = stubRuntime(stubConfig('A', 'Primary', 'model-a'), { userId: undefined });
    mocks.chatCompletions.mockRejectedValue(new LlmError('http', 'HTTP 500', 500));

    await expect(llmCall(rt, messages)).rejects.toThrow('HTTP 500');
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('does not fail over on non-LLM errors (e.g. the per-run token budget)', async () => {
    const rt = stubRuntime(stubConfig('A', 'Primary', 'model-a'));
    mocks.chatCompletions.mockRejectedValue(new Error('LLM token budget exceeded'));

    await expect(llmCall(rt, messages)).rejects.toThrow('LLM token budget exceeded');
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('persists the promoted config id to the task row so the pending-switch check does not bounce back', async () => {
    // applyPendingModelSwitch reads task.llmConfigId as a pending user
    // switch; without this persist it would re-switch the runtime onto the
    // config that just failed on every subsequent LLM call.
    const cfgA = stubConfig('A', 'Primary', 'model-a', true);
    const cfgB = stubConfig('B', 'Backup', 'model-b');
    mocks.findMany.mockResolvedValue([cfgB]);
    mocks.chatCompletions
      .mockRejectedValueOnce(new LlmError('http', 'HTTP 429: rate limited', 429))
      .mockResolvedValueOnce(OK_RESULT);
    const rt = stubRuntime(cfgA, { taskId: 'task-1' });

    await llmCall(rt, messages);

    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { llmConfigId: 'B' },
    });
  });

  it('does not touch the task row when the runtime has no taskId', async () => {
    const cfgA = stubConfig('A', 'Primary', 'model-a');
    const cfgB = stubConfig('B', 'Backup', 'model-b');
    mocks.findMany.mockResolvedValue([cfgB]);
    mocks.chatCompletions
      .mockRejectedValueOnce(new LlmError('http', 'HTTP 500', 500))
      .mockResolvedValueOnce(OK_RESULT);
    const rt = stubRuntime(cfgA);

    await llmCall(rt, messages);

    expect(rt.cfg.id).toBe('B');
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('rethrows the original error when no failover config remains', async () => {
    const cfgA = stubConfig('A', 'Primary', 'model-a');
    mocks.findMany.mockResolvedValue([]);
    mocks.chatCompletions.mockRejectedValue(new LlmError('http', 'HTTP 503', 503));
    const rt = stubRuntime(cfgA);

    await expect(llmCall(rt, messages)).rejects.toThrow('HTTP 503');
    expect(rt.cfg.id).toBe('A');
  });

  it('never retries a config that already failed during this run', async () => {
    const cfgA = stubConfig('A', 'Primary', 'model-a');
    const cfgB = stubConfig('B', 'Backup', 'model-b');
    const queries: unknown[] = [];
    mocks.findMany.mockImplementation((args: unknown) => {
      queries.push(structuredClone(args));
      return Promise.resolve(queries.length === 1 ? [cfgB] : []);
    });
    mocks.chatCompletions.mockRejectedValue(new LlmError('http', 'HTTP 500', 500));
    const rt = stubRuntime(cfgA);

    await expect(llmCall(rt, messages)).rejects.toThrow('HTTP 500');

    expect(queries).toEqual([
      { where: { userId: 'user-1', enabled: true, id: { notIn: ['A'] } },
        orderBy: [{ isDefault: 'desc' }, { id: 'asc' }] },
      { where: { userId: 'user-1', enabled: true, id: { notIn: ['A', 'B'] } },
        orderBy: [{ isDefault: 'desc' }, { id: 'asc' }] },
    ]);
    expect(rt.triedConfigIds).toEqual(['A', 'B']);
  });

  it('skips failover candidates whose baseUrl is not publicly routable', async () => {
    const cfgA = stubConfig('A', 'Primary', 'model-a');
    const cfgB = stubConfig('B', 'Broken', 'model-b');
    const cfgC = stubConfig('C', 'Safe', 'model-c');
    mocks.findMany.mockResolvedValue([cfgB, cfgC]);
    mocks.assertPublicHttpUrl.mockImplementation(async (url: string) => {
      if (url.includes('llm-B')) throw new Error('hostname resolves to a private IP');
      return new URL(url);
    });
    mocks.chatCompletions
      .mockRejectedValueOnce(new LlmError('http', 'HTTP 500', 500))
      .mockResolvedValueOnce(OK_RESULT);
    const rt = stubRuntime(cfgA);

    await llmCall(rt, messages);

    expect(rt.cfg.id).toBe('C');
    expect(mocks.chatCompletions).toHaveBeenCalledTimes(2);
  });
});
