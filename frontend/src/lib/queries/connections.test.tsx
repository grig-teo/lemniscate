// @vitest-environment jsdom
/**
 * Locking tests for the current-user and connection hooks (pinned before the
 * hooks.ts split — they import through the barrel so they must stay green,
 * unmodified, across the move).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { useConnections, useCreateConnection, useDeleteConnection, useMe, useSyncConnection } from '@/lib/hooks';
import {
  cachedQueryKeys,
  createTestQueryClient,
  lastMutationMeta,
  mockFetchSequence,
  renderHookWithClient,
} from '@/lib/queries/test-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useMe', () => {
  it('fetches GET /api/auth/me under the ["me"] key and unwraps .user', async () => {
    const queryClient = createTestQueryClient();
    const user = { id: 'u1', createdAt: '2026-01-01T00:00:00Z' };
    const { calls } = mockFetchSequence({ json: { user } });

    const { result } = renderHookWithClient(() => useMe(), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/auth/me', method: 'GET', body: undefined }]);
    expect(result.current.data).toEqual(user);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['me']);
  });
});

describe('useConnections', () => {
  it('fetches GET /api/connections under ["connections"] and unwraps the list', async () => {
    const queryClient = createTestQueryClient();
    const connections = [{ id: 'c1', provider: 'github', username: 'octo', baseUrl: null }];
    const { calls } = mockFetchSequence({ json: { connections } });

    const { result } = renderHookWithClient(() => useConnections(), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/connections', method: 'GET', body: undefined }]);
    expect(result.current.data).toEqual(connections);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['connections']);
  });
});

describe('useCreateConnection', () => {
  it('POSTs the payload, unwraps .connection, invalidates connections+repositories+tasks, suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const connection = { id: 'c1', provider: 'github', username: 'octo', baseUrl: null };
    const { calls } = mockFetchSequence({ json: { connection } });

    const { result } = renderHookWithClient(() => useCreateConnection(), queryClient);
    result.current.mutate({ provider: 'github', token: 'tok' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      {
        url: '/api/connections',
        method: 'POST',
        body: { provider: 'github', token: 'tok' },
      },
    ]);
    expect(result.current.data).toEqual(connection);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connections'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['repositories'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useDeleteConnection', () => {
  it('DELETEs /api/connections/:id, invalidates, suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ status: 204 });

    const { result } = renderHookWithClient(() => useDeleteConnection(), queryClient);
    result.current.mutate('c1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/connections/c1', method: 'DELETE', body: undefined }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connections'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useSyncConnection', () => {
  it('POSTs /api/connections/:id/sync, invalidates on settled, keeps the global error toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ json: { synced: 3, created: 1, updated: 2 } });

    const { result } = renderHookWithClient(() => useSyncConnection(), queryClient);
    result.current.mutate('c1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/connections/c1/sync', method: 'POST', body: undefined }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connections'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['repositories'] });
    expect(lastMutationMeta(queryClient)).toBeUndefined();
  });
});
