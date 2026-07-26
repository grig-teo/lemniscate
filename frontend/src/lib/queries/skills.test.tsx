// @vitest-environment jsdom
/**
 * Locking tests for the skills and usage hooks (pinned before the hooks.ts
 * split; imports go through the barrel).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import {
  useSkill,
  useSkillCategories,
  useSkills,
  useUpdateSkill,
  useUsage,
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

describe('useSkills', () => {
  it('fetches with the search and category params under ["skills", search, category]', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { skills: [] } });

    const { result } = renderHookWithClient(() => useSkills('rev', 'dev'), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/skills?search=rev&category=dev', method: 'GET', body: undefined },
    ]);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['skills', 'rev', 'dev']);
  });

  it('debounces search changes by ~250ms', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { skills: [] } }, { json: { skills: [] } });

    const { result, rerender } = renderHookWithClient(
      ({ search }: { search: string }) => useSkills(search),
      queryClient,
      { search: 'first' },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls).toHaveLength(1);

    rerender({ search: 'next' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(calls).toHaveLength(1); // still debouncing

    await waitFor(() => expect(calls).toHaveLength(2), { timeout: 1500 });
    expect(calls[1].url).toBe('/api/skills?search=next');
  });

  it('omits empty params entirely', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { skills: [] } });

    const { result } = renderHookWithClient(() => useSkills(''), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/skills', method: 'GET', body: undefined }]);
  });
});

describe('useSkillCategories', () => {
  it('fetches GET /api/skills/categories under ["skill-categories"]', async () => {
    const queryClient = createTestQueryClient();
    const categories = [{ name: 'dev', count: 3 }];
    const { calls } = mockFetchSequence({ json: { categories } });

    const { result } = renderHookWithClient(() => useSkillCategories(), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/skills/categories', method: 'GET', body: undefined }]);
    expect(result.current.data).toEqual(categories);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['skill-categories']);
  });
});

describe('useSkill', () => {
  it('is disabled while the slug is null, then fetches under ["skill", slug]', async () => {
    const queryClient = createTestQueryClient();
    const detail = { slug: 'rev', name: 'Review', content: '# Review' };
    const { calls } = mockFetchSequence({ json: detail });

    const { result, rerender } = renderHookWithClient(
      ({ slug }: { slug: string | null }) => useSkill(slug),
      queryClient,
      { slug: null as string | null },
    );
    rerender({ slug: null });
    expect(result.current.fetchStatus).toBe('idle');

    rerender({ slug: 'rev' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/skills/rev', method: 'GET', body: undefined }]);
    expect(result.current.data).toEqual(detail);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['skill', 'rev']);
  });
});

describe('useUpdateSkill', () => {
  it('PUTs the patch, unwraps .skill, invalidates list+detail, suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const skill = { slug: 'rev', name: 'Review', content: 'new' };
    const { calls } = mockFetchSequence({ json: { skill } });

    const { result } = renderHookWithClient(() => useUpdateSkill(), queryClient);
    result.current.mutate({ slug: 'rev', patch: { content: 'new' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/skills/rev', method: 'PUT', body: { content: 'new' } },
    ]);
    expect(result.current.data).toEqual(skill);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['skills'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['skill', 'rev'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useUsage', () => {
  it('fetches /api/usage?period=… under ["usage", period] with a 30s staleTime', async () => {
    const queryClient = createTestQueryClient();
    const report = { period: '7d', totals: { totalTokens: 1 } };
    const { calls } = mockFetchSequence({ json: report });

    const { result } = renderHookWithClient(() => useUsage('7d'), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/usage?period=7d', method: 'GET', body: undefined }]);
    expect(result.current.data).toEqual(report);
    expect(cachedQueryOptions(queryClient, ['usage', '7d']).staleTime).toBe(30_000);
  });
});
