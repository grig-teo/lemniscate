// @vitest-environment jsdom
/**
 * Locking tests for the services hooks (pinned before the hooks.ts split;
 * imports go through the barrel).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import {
  useCreateService,
  useDeleteService,
  useDeployService,
  useSaveServiceEnv,
  useServiceDeployments,
  useServiceLogs,
  useServices,
  useStopService,
  useUpdateService,
} from '@/lib/hooks';
import {
  cachedQueryKeys,
  cachedQueryOptions,
  createTestQueryClient,
  lastMutationMeta,
  mockFetchSequence,
  renderHookWithClient,
} from '@/lib/queries/test-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useServices', () => {
  it('polls GET /api/services every 5s under ["services"] and unwraps the list', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { services: [] } });

    const { result } = renderHookWithClient(() => useServices(), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/services', method: 'GET', body: undefined }]);
    expect(cachedQueryOptions(queryClient, ['services']).refetchInterval).toBe(5_000);
  });
});

describe('service mutations', () => {
  it('useCreateService POSTs the input, unwraps .service, invalidates, suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const service = { id: 's1' };
    const input = { repositoryId: 'r1', name: 'web', port: 3000 };
    const { calls } = mockFetchSequence({ json: { service } });

    const { result } = renderHookWithClient(() => useCreateService(), queryClient);
    result.current.mutate(input);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/services', method: 'POST', body: input }]);
    expect(result.current.data).toEqual(service);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['services'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });

  it('useUpdateService PATCHes /api/services/:id with the patch', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ json: { service: { id: 's1' } } });

    const { result } = renderHookWithClient(() => useUpdateService('s1'), queryClient);
    result.current.mutate({ port: 4000 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/services/s1', method: 'PATCH', body: { port: 4000 } },
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['services'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });

  it('useDeleteService DELETEs /api/services/:id', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ status: 204 });

    const { result } = renderHookWithClient(() => useDeleteService(), queryClient);
    result.current.mutate('s1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/services/s1', method: 'DELETE', body: undefined }]);
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });

  it('useDeployService POSTs /api/services/:id/deploy', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ json: { deployment: { id: 'dep1' } } });

    const { result } = renderHookWithClient(() => useDeployService(), queryClient);
    result.current.mutate('s1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/services/s1/deploy', method: 'POST', body: undefined },
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['services'] });
  });

  it('useStopService POSTs /api/services/:id/stop and invalidates', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ json: {} });

    const { result } = renderHookWithClient(() => useStopService(), queryClient);
    result.current.mutate('s1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/services/s1/stop', method: 'POST', body: undefined }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['services'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });

  it('useSaveServiceEnv PUTs the env patch to /api/services/:id/env', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const patch = { set: { KEY: 'value' }, remove: ['OLD'] };
    const { calls } = mockFetchSequence({ json: { keys: ['KEY'] } });

    const { result } = renderHookWithClient(() => useSaveServiceEnv('s1'), queryClient);
    result.current.mutate(patch);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/services/s1/env', method: 'PUT', body: patch }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['services'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useServiceDeployments', () => {
  it('is disabled while the id is null, then polls every 5s and unwraps .deployments', async () => {
    const queryClient = createTestQueryClient();
    const deployments = [{ id: 'dep1' }];
    const { calls } = mockFetchSequence({ json: { deployments } });

    const { result, rerender } = renderHookWithClient(
      ({ id }: { id: string | null }) => useServiceDeployments(id),
      queryClient,
      { id: null as string | null },
    );
    rerender({ id: null });
    expect(result.current.fetchStatus).toBe('idle');

    rerender({ id: 's1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/services/s1/deployments', method: 'GET', body: undefined },
    ]);
    expect(result.current.data).toEqual(deployments);
    expect(cachedQueryOptions(queryClient, ['service-deployments', 's1']).refetchInterval).toBe(5_000);
  });
});

describe('useServiceLogs', () => {
  it('fetches logs only when enabled and unwraps .log', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { log: 'hello' } });

    const { result, rerender } = renderHookWithClient(
      ({ enabled }: { enabled: boolean }) => useServiceLogs('s1', enabled),
      queryClient,
      { enabled: false },
    );
    rerender({ enabled: false });
    expect(result.current.fetchStatus).toBe('idle');

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/services/s1/logs', method: 'GET', body: undefined }]);
    expect(result.current.data).toBe('hello');
    expect(cachedQueryKeys(queryClient)).toContainEqual(['service-logs', 's1']);
  });
});
