// @vitest-environment jsdom
/**
 * Locking tests for the device hooks (pinned before the hooks.ts split;
 * imports go through the barrel).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import {
  useCreateDeviceCommand,
  useCreatePairing,
  useDeleteDevice,
  useDeviceCommands,
  useDevices,
  useRenameDevice,
  useTaskRunTargets,
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

describe('useDevices', () => {
  it('polls GET /api/devices every 15s by default under ["devices"]', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { devices: [] } });

    const { result } = renderHookWithClient(() => useDevices(), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/devices', method: 'GET', body: undefined }]);
    expect(cachedQueryOptions(queryClient, ['devices']).refetchInterval).toBe(15_000);
  });

  it('honors a refetchInterval override', async () => {
    const queryClient = createTestQueryClient();
    mockFetchSequence({ json: { devices: [] } });

    const { result } = renderHookWithClient(
      () => useDevices({ refetchInterval: false }),
      queryClient,
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(cachedQueryOptions(queryClient, ['devices']).refetchInterval).toBe(false);
  });
});

describe('useCreatePairing', () => {
  it('POSTs /api/devices/pairings and suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const pairing = { code: 'ABC123', expiresAt: '2026-07-26T12:00:00Z' };
    const { calls } = mockFetchSequence({ json: pairing });

    const { result } = renderHookWithClient(() => useCreatePairing(), queryClient);
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/devices/pairings', method: 'POST', body: undefined }]);
    expect(result.current.data).toEqual(pairing);
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });
});

describe('useRenameDevice', () => {
  it('PATCHes { name }, unwraps .device, invalidates ["devices"]', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const device = { id: 'd1', name: 'workstation' };
    const { calls } = mockFetchSequence({ json: { device } });

    const { result } = renderHookWithClient(() => useRenameDevice(), queryClient);
    result.current.mutate({ id: 'd1', name: 'workstation' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/devices/d1', method: 'PATCH', body: { name: 'workstation' } },
    ]);
    expect(result.current.data).toEqual(device);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['devices'] });
    expect(lastMutationMeta(queryClient)).toBeUndefined();
  });
});

describe('useDeleteDevice', () => {
  it('DELETEs /api/devices/:id and invalidates ["devices"]', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { calls } = mockFetchSequence({ status: 204 });

    const { result } = renderHookWithClient(() => useDeleteDevice(), queryClient);
    result.current.mutate('d1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([{ url: '/api/devices/d1', method: 'DELETE', body: undefined }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['devices'] });
  });
});

describe('useDeviceCommands', () => {
  it('is disabled while the id is null, then polls every 5s', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { commands: [] } });

    const { result, rerender } = renderHookWithClient(
      ({ id }: { id: string | null }) => useDeviceCommands(id),
      queryClient,
      { id: null as string | null },
    );
    rerender({ id: null });
    expect(result.current.fetchStatus).toBe('idle');

    rerender({ id: 'd1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/devices/d1/commands', method: 'GET', body: undefined },
    ]);
    expect(cachedQueryOptions(queryClient, ['device-commands', 'd1']).refetchInterval).toBe(5_000);
  });
});

describe('useTaskRunTargets', () => {
  it('fetches run targets under ["task-run-targets", id] and unwraps .targets', async () => {
    const queryClient = createTestQueryClient();
    const targets = [{ target: 'web', commandType: 'run_web', devices: [] }];
    const { calls } = mockFetchSequence({ json: { targets } });

    const { result } = renderHookWithClient(() => useTaskRunTargets('t1'), queryClient);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      { url: '/api/tasks/t1/run-targets', method: 'GET', body: undefined },
    ]);
    expect(result.current.data).toEqual(targets);
    expect(cachedQueryKeys(queryClient)).toContainEqual(['task-run-targets', 't1']);
  });

  it('stays disabled without a task id or when enabled is false', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { targets: [] } });

    renderHookWithClient(() => useTaskRunTargets(null), queryClient);
    renderHookWithClient(() => useTaskRunTargets('t1', false), queryClient);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toEqual([]);
  });
});

describe('useCreateDeviceCommand', () => {
  it('POSTs { type, payload }, unwraps .command, invalidates commands+devices, suppresses the toast', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const command = { id: 'cmd1', type: 'run_web', status: 'queued' };
    const { calls } = mockFetchSequence({ json: { command } });

    const { result } = renderHookWithClient(() => useCreateDeviceCommand(), queryClient);
    result.current.mutate({
      deviceId: 'd1',
      type: 'run_web',
      payload: { repoUrl: 'https://x', branch: 'main', port: 8080 },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toEqual([
      {
        url: '/api/devices/d1/commands',
        method: 'POST',
        body: { type: 'run_web', payload: { repoUrl: 'https://x', branch: 'main', port: 8080 } },
      },
    ]);
    expect(result.current.data).toEqual(command);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['device-commands', 'd1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['devices'] });
    expect(lastMutationMeta(queryClient)).toEqual({ suppressErrorToast: true });
  });

  it('includes taskId in the body only when set', async () => {
    const queryClient = createTestQueryClient();
    const { calls } = mockFetchSequence({ json: { command: {} } });

    const { result } = renderHookWithClient(() => useCreateDeviceCommand(), queryClient);
    result.current.mutate({ deviceId: 'd1', type: 'run_web', payload: {}, taskId: 't1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls[0].body).toEqual({ type: 'run_web', payload: {}, taskId: 't1' });
  });
});
