import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tests for the per-task event cap in publishTaskEvent: when the number of
// events for a task exceeds TASK_EVENT_MAX_PER_TASK, the oldest events are
// pruned and a single "earlier output truncated" marker is ensured.
//
// Additional coverage for review-requested fixes:
// - Cap deletion uses id-based notIn (not timestamp lt) so ties don't inflate
//   the survivor count beyond K.
// - The truncation marker check-and-create runs inside a transaction with an
//   advisory lock, eliminating the findFirst+create TOCTOU race.
// - Cap enforcement runs at most once every TASK_EVENT_CAP_CHECK_INTERVAL
//   publishes, not on every write (avoids per-event DB overhead).
// - Survivor count is K-1 so the marker fits within the cap (total = K),
//   preventing steady-state K+1 that re-triggers enforcement every publish.

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => {
  const prisma = {
    taskEvent: {
      create: mocks.create,
      count: mocks.count,
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
      deleteMany: mocks.deleteMany,
    },
    $queryRaw: mocks.queryRaw,
    $transaction: mocks.transaction,
  };
  return { prisma };
});

vi.mock('ioredis', () => ({
  Redis: class MockRedis {
    publish = mocks.publish;
  },
}));

import { config } from '../src/config.js';
import {
  publishTaskEvent,
  resetCapCounters,
  TASK_EVENT_CAP_CHECK_INTERVAL,
} from '../src/lib/task-events.js';

const K = config.TASK_EVENT_MAX_PER_TASK;
const MARKER_LINE = '— earlier output truncated —';

// Survivor ids returned by the findMany cap query.
function survivorIds(n: number): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `survivor-${i}` }));
}

// Pass-through $transaction mock: runs the callback with a tx object that
// shares the same taskEvent + $queryRaw mocks as top-level prisma.
function passthroughTransaction(): void {
  mocks.transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        taskEvent: { create: mocks.create, findFirst: mocks.findFirst },
        $queryRaw: mocks.queryRaw,
      }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCapCounters();
  mocks.create.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'evt-id',
    kind: 'log',
    payload: data.payload,
    createdAt: new Date(),
  }));
  mocks.publish.mockResolvedValue('OK');
  mocks.queryRaw.mockResolvedValue(undefined);
  passthroughTransaction();
});

// Publish exactly TASK_EVENT_CAP_CHECK_INTERVAL events for a task so the
// modulo counter triggers the cap check on the last call.
async function publishUpToCheck(taskId: string): Promise<void> {
  for (let i = 0; i < TASK_EVENT_CAP_CHECK_INTERVAL - 1; i++) {
    await publishTaskEvent(taskId, 'log', { line: `line-${i}` });
  }
}

describe('publishTaskEvent per-task cap', () => {
  it('does not prune when the event count is within the cap', async () => {
    mocks.count.mockResolvedValue(K);

    await publishUpToCheck('task-1');
    await publishTaskEvent('task-1', 'log', { line: 'trigger-check' });

    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it('prunes by deleting ids not among the newest K-1 survivors', async () => {
    mocks.count.mockResolvedValue(K + 10);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K - 1));
    mocks.deleteMany.mockResolvedValue({ count: 11 });
    mocks.findFirst.mockResolvedValueOnce(null); // marker not found
    mocks.create.mockResolvedValueOnce({
      id: 'marker',
      kind: 'log',
      payload: { line: MARKER_LINE },
      createdAt: new Date(),
    });

    await publishUpToCheck('task-1');
    await publishTaskEvent('task-1', 'log', { line: 'overflow' });

    const deleteCall = mocks.deleteMany.mock.calls[0][0] as {
      where: { taskId: string; id?: { notIn: string[] }; createdAt?: unknown };
    };
    expect(deleteCall.where.taskId).toBe('task-1');
    expect(deleteCall.where.id?.notIn).toHaveLength(K - 1);
    // Must NOT use a timestamp comparison (which can over-keep on ties).
    expect(deleteCall.where.createdAt).toBeUndefined();
  });

  it('queries K-1 survivors ordered by createdAt desc then id desc', async () => {
    mocks.count.mockResolvedValue(K + 1);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K - 1));
    mocks.deleteMany.mockResolvedValue({ count: 2 });
    mocks.findFirst.mockResolvedValueOnce({ id: 'existing' });

    await publishUpToCheck('task-1');
    await publishTaskEvent('task-1', 'log', { line: 'x' });

    const query = mocks.findMany.mock.calls[0][0] as {
      orderBy: unknown[];
      take: number;
    };
    expect(query.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(query.take).toBe(K - 1);
  });

  it('inserts exactly one truncation marker when pruning removes rows', async () => {
    mocks.count.mockResolvedValue(K + 5);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K - 1));
    mocks.deleteMany.mockResolvedValue({ count: 6 });
    mocks.findFirst.mockResolvedValueOnce(null);
    mocks.create.mockResolvedValue({
      id: 'marker',
      kind: 'log',
      payload: { line: MARKER_LINE },
      createdAt: new Date(),
    });

    await publishUpToCheck('task-1');
    await publishTaskEvent('task-1', 'log', { line: 'x' });

    const markerCreate = mocks.create.mock.calls.find((call) => {
      const data = call[0] as { data: { payload: { line?: string } } };
      return data.data.payload?.line === MARKER_LINE;
    });
    expect(markerCreate).toBeDefined();
  });

  it('does not insert a duplicate truncation marker', async () => {
    mocks.count.mockResolvedValue(K + 5);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K - 1));
    mocks.deleteMany.mockResolvedValue({ count: 6 });
    mocks.findFirst.mockResolvedValueOnce({ id: 'existing-marker' });

    await publishUpToCheck('task-1');
    await publishTaskEvent('task-1', 'log', { line: 'x' });

    const markerCreates = mocks.create.mock.calls.filter((call) => {
      const data = call[0] as { data: { payload: { line?: string } } };
      return data.data.payload?.line === MARKER_LINE;
    });
    expect(markerCreates).toHaveLength(0);
  });

  it('does not create a marker when deleteMany removes nothing', async () => {
    mocks.count.mockResolvedValue(K + 1);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K - 1));
    mocks.deleteMany.mockResolvedValue({ count: 0 });

    await publishUpToCheck('task-1');
    await publishTaskEvent('task-1', 'log', { line: 'x' });

    // Only the TASK_EVENT_CAP_CHECK_INTERVAL original event creates (no marker).
    expect(mocks.create).toHaveBeenCalledTimes(TASK_EVENT_CAP_CHECK_INTERVAL);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('cap enforcement interval (modulo counter)', () => {
  it('does not query count before reaching the check interval', async () => {
    await publishTaskEvent('task-1', 'log', { line: 'first' });

    expect(mocks.count).not.toHaveBeenCalled();
  });

  it('triggers enforcement exactly at the check interval boundary', async () => {
    mocks.count.mockResolvedValue(0);

    for (let i = 0; i < TASK_EVENT_CAP_CHECK_INTERVAL; i++) {
      await publishTaskEvent('task-1', 'log', { line: `line-${i}` });
    }

    expect(mocks.count).toHaveBeenCalledTimes(1);
  });

  it('does not trigger enforcement again until the next interval', async () => {
    mocks.count.mockResolvedValue(0);

    for (let i = 0; i < TASK_EVENT_CAP_CHECK_INTERVAL + 10; i++) {
      await publishTaskEvent('task-1', 'log', { line: `line-${i}` });
    }

    expect(mocks.count).toHaveBeenCalledTimes(1);
  });

  it('tracks counters independently per task', async () => {
    mocks.count.mockResolvedValue(0);

    for (let i = 0; i < TASK_EVENT_CAP_CHECK_INTERVAL; i++) {
      await publishTaskEvent('task-A', 'log', { line: `a-${i}` });
      await publishTaskEvent('task-B', 'log', { line: `b-${i}` });
    }

    // Each task should have triggered exactly one check.
    expect(mocks.count).toHaveBeenCalledTimes(2);
  });
});

describe('ensureTruncationMarker TOCTOU safety', () => {
  it('runs the marker check-and-create inside a transaction', async () => {
    mocks.count.mockResolvedValue(K + 5);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K - 1));
    mocks.deleteMany.mockResolvedValue({ count: 6 });
    mocks.findFirst.mockResolvedValueOnce(null);
    mocks.create.mockResolvedValue({
      id: 'marker',
      kind: 'log',
      payload: { line: MARKER_LINE },
      createdAt: new Date(),
    });

    await publishUpToCheck('task-1');
    await publishTaskEvent('task-1', 'log', { line: 'x' });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('acquires the advisory lock before checking for an existing marker', async () => {
    const callOrder: string[] = [];
    mocks.count.mockResolvedValue(K + 5);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K - 1));
    mocks.deleteMany.mockResolvedValue({ count: 6 });
    mocks.queryRaw.mockImplementation(async () => {
      callOrder.push('lock');
    });
    mocks.findFirst.mockImplementationOnce(async () => {
      callOrder.push('check');
      return null;
    });
    mocks.create
      .mockImplementation(async ({ data }: { data: { payload?: unknown } }) => {
        const payload = data.payload as { line?: string };
        if (payload?.line === MARKER_LINE) {
          callOrder.push('create');
          return {
            id: 'marker',
            kind: 'log',
            payload: { line: MARKER_LINE },
            createdAt: new Date(),
          };
        }
        return { id: 'evt', kind: 'log', payload: {}, createdAt: new Date() };
      });

    await publishUpToCheck('task-1');
    await publishTaskEvent('task-1', 'log', { line: 'x' });

    expect(callOrder).toContain('lock');
    expect(callOrder).toContain('check');
    expect(callOrder).toContain('create');
    expect(callOrder.indexOf('lock')).toBeLessThan(callOrder.indexOf('check'));
  });
});
