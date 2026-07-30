// @vitest-environment jsdom
/**
 * Locking tests for the task hooks (pinned before the hooks.ts split — they
 * import through the barrel so they must stay green, unmodified, across the
 * move and the mutation-wrapper unification).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, waitFor } from '@testing-library/react';

import {
  useArchiveTask,
  useCancelTask,
  useClosePrTask,
  useCreateTask,
  useGenerateProposals,
  useHasActiveProcesses,
  useImproveTask,
  usePatchTaskLlmConfig,
  useRerunTask,
  useStartTask,
  useTask,
  useTasks,
  useUnarchiveTask,
} from '@/lib/hooks';
import {
  cachedQueryKeys,
  createTestQueryClient,
  lastMutationMeta,
  mockFetchSequence,
  renderHookWithClient,
} from '@/lib/queries/test-helpers';

const task = { id: 't1', repositoryId: 'r1', title: 'Task', status: 'pending' };

afterEach(() => {
  cleanup(); // unmount renderHook output so polling observers don't leak across tests
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useTasks', () => {
  it('lists active tasks under ["tasks", id, "active"] with the repositoryId param', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { tasks: [task] } });

    const { result } = renderHookWithClient(() => useTasks('r1'), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/tasks?repositoryId=r1', method: 'GET', body: undefined },
    ]);
    expect(result.current.data).toEqual([task]);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['tasks', 'r1', 'active']);
  });

  it('uses the null id and archived flag in the key and the archived param', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { tasks: [] } });

    const { result } = renderHookWithClient(
      () => useTasks(null, { archived: true }),
      queryClient,
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/tasks?archived=true', method: 'GET', body: undefined }]);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['tasks', null, 'archived']);
  });

  it('fetches /api/tasks with no params when no repository is selected', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { tasks: [] } });

    const { result } = renderHookWithClient(() => useTasks(), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/tasks', method: 'GET', body: undefined }]);
  });

  it('respects enabled: false', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { tasks: [] } });

    renderHookWithClient(() => useTasks('r1', { enabled: false }), queryClient);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toEqual([]);
  });
});

describe('useTask', () => {
  it('is disabled until an id is set, then fetches under ["task", id]', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { task } });

    const { result, rerender } = renderHookWithClient(
      ({ id }: { id: string | null }) => useTask(id),
      queryClient,
      { id: null as string | null },
    );
    rerender({ id: null });
    expect(result.current.fetchStatus).toBe('idle');

    rerender({ id: 't1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/tasks/t1', method: 'GET', body: undefined }]);
    expect(result.current.data).toEqual(task);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['task', 't1']);
  });
});

describe('useCreateTask', () => {
  it('POSTs the body, unwraps .task, invalidates tasks lists, suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const body = { repositoryId: 'r1', prompt: 'do it', thinkingLevel: 'high' as const };
    const { calls } = mockFetchSequence({ json: { task } });

    const { result } = renderHookWithClient(() => useCreateTask(), queryClient);
    result.current.mutate(body);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/tasks', method: 'POST', body }]);
    expect(result.current.data).toEqual(task);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks', 'r1'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useStartTask', () => {
  it('accepts a bare id string and posts with no body', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: {} });

    const { result } = renderHookWithClient(() => useStartTask(), queryClient);
    result.current.mutate('t1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/tasks/t1/start', method: 'POST', body: undefined }]);
  });

  it('accepts { id, body } and invalidates the task lists', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ json: {} });

    const { result } = renderHookWithClient(() => useStartTask(), queryClient);
    result.current.mutate({ id: 't1', body: { title: 'New title' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/tasks/t1/start', method: 'POST', body: { title: 'New title' } },
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task'] });
    expect(lastMutationMeta(queryClient)).toBeUndefined();
  });
});

describe('useImproveTask', () => {
  it('POSTs /api/tasks/:id/improve and suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({
      json: { prompt: 'improved', estimatedTime: 'about 2 hours' },
    });

    const { result } = renderHookWithClient(() => useImproveTask(), queryClient);
    result.current.mutate({ id: 't1', body: { title: 'T', prompt: 'P' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/tasks/t1/improve', method: 'POST', body: { title: 'T', prompt: 'P' } },
    ]);
    expect(result.current.data).toEqual({ prompt: 'improved', estimatedTime: 'about 2 hours' });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useGenerateProposals', () => {
  it('POSTs /api/repositories/:id/proposals and invalidates ["tasks", id] on settled', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ status: 202, json: {} });

    const { result } = renderHookWithClient(() => useGenerateProposals(), queryClient);
    result.current.mutate('r1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/repositories/r1/proposals', method: 'POST', body: undefined },
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks', 'r1'] });
  });
});

describe('useHasActiveProcesses', () => {
  const runningTask = {
    id: 't1',
    repositoryId: 'r1',
    kind: 'prompt',
    title: 'T',
    status: 'running',
    archivedAt: null,
    llmTokensUsed: 0,
    createdAt: '',
    updatedAt: '',
  };
  const doneTask = { ...runningTask, id: 't2', status: 'done' };
  const user = { id: 'u1', createdAt: '' };

  it('is true when any task is running or awaiting review', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence(
      { json: { user } },
      { json: { tasks: [doneTask, runningTask] } },
    );

    const { result } = renderHookWithClient(() => useHasActiveProcesses(), queryClient);
    await waitFor(() => expect(result.current).toBe(true));

    // tasks are only fetched once authenticated (me resolves first)
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/me', '/api/tasks']);
  });

  it('is false when only idle tasks exist', async () => {
    const queryClient = createTestQueryClient();
    mockFetchSequence({ json: { user } }, { json: { tasks: [doneTask] } });

    const { result } = renderHookWithClient(() => useHasActiveProcesses(), queryClient);
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('does not fetch tasks and stays false when not authenticated', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ status: 401, json: { error: 'unauthorized' } });

    const { result } = renderHookWithClient(() => useHasActiveProcesses(), queryClient);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(result.current).toBe(false);
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/me']);
  });
});

describe.each([
  ['rerun', useRerunTask],
  ['cancel', useCancelTask],
  ['archive', useArchiveTask],
  ['unarchive', useUnarchiveTask],
  ['close-pr', useClosePrTask],
])('useTaskAction %s', (action, useHook) => {
  it(`POSTs /api/tasks/:id/${action} and invalidates ["tasks"] and ["task"]`, async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ json: {} });

    const { result } = renderHookWithClient(() => useHook(), queryClient);
    result.current.mutate('t1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: `/api/tasks/t1/${action}`, method: 'POST', body: undefined },
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task'] });
    expect(lastMutationMeta(queryClient)).toBeUndefined();
  });
});

describe('usePatchTaskLlmConfig', () => {
  it('PATCHes /api/tasks/:id with { llmConfigId } and invalidates the task, suppressing the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const updated = { id: 't1', repositoryId: 'r1', title: 'T', status: 'pending', llmConfigId: 'cfg-2' };
    const { calls } = mockFetchSequence({ json: { task: updated } });

    const { result } = renderHookWithClient(() => usePatchTaskLlmConfig(), queryClient);
    result.current.mutate({ id: 't1', llmConfigId: 'cfg-2' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/tasks/t1', method: 'PATCH', body: { llmConfigId: 'cfg-2' } },
    ]);
    expect(result.current.data).toEqual({ task: updated });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});
