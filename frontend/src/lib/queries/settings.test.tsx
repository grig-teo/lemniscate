// @vitest-environment jsdom
/** Tests for the settings hooks (Settings → Agent tab): GET /api/settings
 *  and the agent-executor mutation. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { useAgentSettings, useUpdateAgentExecutor } from '@/lib/queries/settings';
import {
  cachedQueryKeys,
  createTestQueryClient,
  lastMutationMeta,
  mockFetchSequence,
  renderHookWithClient,
} from '@/lib/queries/test-helpers';

const settings = {
  agentExecutor: 'hermes',
  defaultAgentExecutor: 'hermes',
  override: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useAgentSettings', () => {
  it('fetches GET /api/settings under ["settings"]', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: settings });

    const { result } = renderHookWithClient(() => useAgentSettings(), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/settings', method: 'GET', body: undefined }]);
    expect(result.current.data).toEqual(settings);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['settings']);
  });
});

describe('useUpdateAgentExecutor', () => {
  it('PUTs the choice, invalidates ["settings"], suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const updated = { ...settings, agentExecutor: 'internal', override: 'internal' };
    const { calls } = mockFetchSequence({ json: updated });

    const { result } = renderHookWithClient(() => useUpdateAgentExecutor(), queryClient);
    result.current.mutate('internal');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/settings/agent-executor', method: 'PUT', body: { agentExecutor: 'internal' } },
    ]);
    expect(result.current.data).toEqual(updated);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});
