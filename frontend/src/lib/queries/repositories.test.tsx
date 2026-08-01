// @vitest-environment jsdom
/**
 * Locking tests for the repository hooks — including the optimistic
 * cache update and rollback of useUpdateRepositoryFlags/useUpdateRepository
 * (pinned before the hooks.ts split; imports go through the barrel).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import {
  useDeleteRepository,
  useProposalGenerationStatus,
  useRepositories,
  useUpdateAllRepositoryFlags,
  useUpdateRepository,
  useUpdateRepositoryFlags,
  type Repository,
} from '@/lib/hooks';
import {
  cachedQueryKeys,
  cachedQueryOptions,
  createTestQueryClient,
  lastMutationMeta,
  mockFetchSequence,
  renderHookWithClient,
} from '@/lib/queries/test-helpers';

const repo = {
  id: 'r1',
  name: 'app',
  autoCreatePr: false,
  connection: { provider: 'github', username: 'octo' },
} as unknown as Repository;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useRepositories', () => {
  it('fetches GET /api/repositories under ["repositories"] and unwraps the list', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { repositories: [repo] } });

    const { result } = renderHookWithClient(() => useRepositories(), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/repositories', method: 'GET', body: undefined }]);
    expect(result.current.data).toEqual([repo]);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['repositories']);
  });
});

describe('useProposalGenerationStatus', () => {
  it('polls the proposals status every 10s under ["proposal-generation-status", id]', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { generating: true } });

    const { result } = renderHookWithClient(() => useProposalGenerationStatus('r1'), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/repositories/r1/proposals/status', method: 'GET', body: undefined },
    ]);
    expect(result.current.data).toBe(true);
    expect(cachedQueryOptions(queryClient, ['proposal-generation-status', 'r1']).refetchInterval).toBe(10_000);
  });
});

describe('useUpdateRepositoryFlags', () => {
  it('PATCHes, applies an optimistic cache update, and invalidates on settled', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['repositories'], [repo]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ json: { repository: { ...repo, autoCreatePr: true } } });

    const { result } = renderHookWithClient(() => useUpdateRepositoryFlags(), queryClient);
    result.current.mutate({ id: 'r1', patch: { autoCreatePr: true } });

    // Optimistic update lands before the server responds.
    await waitFor(() =>
      expect(queryClient.getQueryData<Repository[]>(['repositories'])?.[0].autoCreatePr).toBe(true),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/repositories/r1', method: 'PATCH', body: { autoCreatePr: true } },
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['repositories'] });
    expect(lastMutationMeta(queryClient)).toBeUndefined();
  });

  it('rolls the cache back on error', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['repositories'], [repo]);
    mockFetchSequence({ status: 500, json: { message: 'boom' } });

    const { result } = renderHookWithClient(() => useUpdateRepositoryFlags(), queryClient);
    result.current.mutate({ id: 'r1', patch: { autoCreatePr: true } });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(queryClient.getQueryData<Repository[]>(['repositories'])?.[0].autoCreatePr).toBe(false);
  });
});

describe('useDeleteRepository', () => {
  it('DELETEs the repo, optimistically drops it from the list cache, and invalidates on settled', async () => {
    const other = { ...repo, id: 'r2' } as Repository;
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['repositories'], [repo, other]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ status: 204 });

    const { result } = renderHookWithClient(() => useDeleteRepository(), queryClient);
    result.current.mutate('r1');

    // Optimistic removal lands before the server responds.
    await waitFor(() =>
      expect(queryClient.getQueryData<Repository[]>(['repositories'])).toEqual([other]),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/repositories/r1', method: 'DELETE', body: undefined }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['repositories'] });
  });

  it('rolls the cache back on error', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['repositories'], [repo]);
    mockFetchSequence({ status: 500, json: { message: 'boom' } });

    const { result } = renderHookWithClient(() => useDeleteRepository(), queryClient);
    result.current.mutate('r1');
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(queryClient.getQueryData<Repository[]>(['repositories'])).toEqual([repo]);
  });
});

describe('useUpdateAllRepositoryFlags', () => {
  it('POSTs /api/repositories/flags, invalidates ["repositories"], suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const flags = { autoCreatePr: true, autoReviewPr: false, autoMergePr: false, autoAddressReview: false };
    const { calls } = mockFetchSequence({ json: { updated: 2 } });

    const { result } = renderHookWithClient(() => useUpdateAllRepositoryFlags(), queryClient);
    result.current.mutate(flags);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/repositories/flags', method: 'POST', body: flags }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['repositories'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useUpdateRepository', () => {
  it('PATCHes the skill selection optimistically and suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['repositories'], [repo]);
    const { calls } = mockFetchSequence({
      json: { repository: { ...repo, skillSlugs: ['review'] } },
    });

    const { result } = renderHookWithClient(() => useUpdateRepository(), queryClient);
    result.current.mutate({ id: 'r1', patch: { skillSlugs: ['review'] } });

    await waitFor(() =>
      expect(queryClient.getQueryData<Repository[]>(['repositories'])?.[0].skillSlugs).toEqual([
        'review',
      ]),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/repositories/r1', method: 'PATCH', body: { skillSlugs: ['review'] } },
    ]);
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useCreateRepository', () => {
  it('POSTs to /api/connections/:id/repositories, invalidates, reports initialized+initTask', async () => {
    const { useCreateRepository } = await import('@/lib/hooks');
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const initialized = { warnings: [] };
    const { calls } = mockFetchSequence({
      json: { repository: repo, sync: null, initialized, initTask: { id: 't9' } },
    });
    const onCreated = vi.fn();

    const { result } = renderHookWithClient(() => useCreateRepository(onCreated), queryClient);
    result.current.mutate({ connectionId: 'c1', body: { name: 'app', private: true, readme: true } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      {
        url: '/api/connections/c1/repositories',
        method: 'POST',
        body: { name: 'app', private: true, readme: true },
      },
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['repositories'] });
    expect(onCreated).toHaveBeenCalledWith(initialized, { id: 't9' });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});
