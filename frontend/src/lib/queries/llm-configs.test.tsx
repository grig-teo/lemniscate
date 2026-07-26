// @vitest-environment jsdom
/**
 * Locking tests for the LLM-config hooks (pinned before the hooks.ts split —
 * they import through the barrel so they must stay green, unmodified).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import {
  useCreateLlmConfig,
  useDeleteLlmConfig,
  useLlmConfigs,
  useTestLlmConfig,
  useUpdateLlmConfig,
} from '@/lib/hooks';
import {
  cachedQueryKeys,
  createTestQueryClient,
  lastMutationMeta,
  mockFetchSequence,
  renderHookWithClient,
} from '@/lib/queries/test-helpers';

const config = { id: 'lc1', name: 'GPT', model: 'gpt-x' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useLlmConfigs', () => {
  it('fetches GET /api/llm-configs under ["llm-configs"] and unwraps .configs', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { configs: [config] } });

    const { result } = renderHookWithClient(() => useLlmConfigs(), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/llm-configs', method: 'GET', body: undefined }]);
    expect(result.current.data).toEqual([config]);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['llm-configs']);
  });
});

describe('useCreateLlmConfig', () => {
  it('POSTs the payload, invalidates ["llm-configs"], suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const payload = { name: 'GPT', baseUrl: 'https://api', model: 'gpt-x' };
    const { calls } = mockFetchSequence({ json: config });

    const { result } = renderHookWithClient(() => useCreateLlmConfig(), queryClient);
    result.current.mutate(payload);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/llm-configs', method: 'POST', body: payload }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm-configs'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useUpdateLlmConfig', () => {
  it('PATCHes /api/llm-configs/:id, invalidates, suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const payload = { name: 'GPT', baseUrl: 'https://api', model: 'gpt-y' };
    const { calls } = mockFetchSequence({ json: config });

    const { result } = renderHookWithClient(() => useUpdateLlmConfig(), queryClient);
    result.current.mutate({ id: 'lc1', payload });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/llm-configs/lc1', method: 'PATCH', body: payload }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm-configs'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useDeleteLlmConfig', () => {
  it('DELETEs /api/llm-configs/:id, invalidates, suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ status: 204 });

    const { result } = renderHookWithClient(() => useDeleteLlmConfig(), queryClient);
    result.current.mutate('lc1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/llm-configs/lc1', method: 'DELETE', body: undefined }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm-configs'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useTestLlmConfig', () => {
  it('tests a saved config via POST /api/llm-configs/:id/test with no body', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { ok: true, latencyMs: 42 } });

    const { result } = renderHookWithClient(() => useTestLlmConfig(), queryClient);
    result.current.mutate({ id: 'lc1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/llm-configs/lc1/test', method: 'POST', body: undefined },
    ]);
    expect(result.current.data).toEqual({ ok: true, latencyMs: 42 });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });

  it('tests form contents via POST /api/llm-configs/test with the payload', async () => {
    const queryClient = createTestQueryClient();
    const payload = { name: 'X', baseUrl: 'https://api', model: 'm' };
    const { calls } = mockFetchSequence({ json: { ok: false, error: 'nope' } });

    const { result } = renderHookWithClient(() => useTestLlmConfig(), queryClient);
    result.current.mutate({ payload });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/llm-configs/test', method: 'POST', body: payload }]);
    expect(result.current.data).toEqual({ ok: false, error: 'nope' });
  });
});
