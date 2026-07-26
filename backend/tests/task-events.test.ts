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
import { publishTaskEvent } from '../src/lib/task-events.js';

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

describe('publishTaskEvent per-task cap', () => {
  it('does not prune when the event count is within the cap', async () => {
    mocks.count.mockResolvedValue(K);

    await publishTaskEvent('task-1', 'log', { line: 'hello' });

    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it('prunes by deleting ids not among the newest K survivors', async () => {
    mocks.count.mockResolvedValue(K + 10);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K));
    mocks.deleteMany.mockResolvedValue({ count: 10 });
    mocks.findFirst.mockResolvedValueOnce(null); // marker not found
    mocks.create.mockResolvedValueOnce({
      id: 'marker',
      kind: 'log',
      payload: { line: MARKER_LINE },
      createdAt: new Date(),
    });

    await publishTaskEvent('task-1', 'log', { line: 'overflow' });

    const deleteCall = mocks.deleteMany.mock.calls[0][0] as {
      where: { taskId: string; id?: { notIn: string[] }; createdAt?: unknown };
    };
    expect(deleteCall.where.taskId).toBe('task-1');
    expect(deleteCall.where.id?.notIn).toHaveLength(K);
    // Must NOT use a timestamp comparison (which can over-keep on ties).
    expect(deleteCall.where.createdAt).toBeUndefined();
  });

  it('queries survivors ordered by createdAt desc then id desc for deterministic ties', async () => {
    mocks.count.mockResolvedValue(K + 1);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K));
    mocks.deleteMany.mockResolvedValue({ count: 1 });
    mocks.findFirst.mockResolvedValueOnce({ id: 'existing' });

    await publishTaskEvent('task-1', 'log', { line: 'x' });

    const query = mocks.findMany.mock.calls[0][0] as {
      orderBy: unknown[];
      take: number;
    };
    expect(query.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(query.take).toBe(K);
  });

  it('inserts exactly one truncation marker when pruning removes rows', async () => {
    mocks.count.mockResolvedValue(K + 5);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K));
    mocks.deleteMany.mockResolvedValue({ count: 5 });
    mocks.findFirst.mockResolvedValueOnce(null);
    mocks.create.mockResolvedValue({
      id: 'marker',
      kind: 'log',
      payload: { line: MARKER_LINE },
      createdAt: new Date(),
    });

    await publishTaskEvent('task-1', 'log', { line: 'x' });

    const markerCreate = mocks.create.mock.calls.find((call) => {
      const data = call[0] as { data: { payload: { line?: string } } };
      return data.data.payload?.line === MARKER_LINE;
    });
    expect(markerCreate).toBeDefined();
  });

  it('does not insert a duplicate truncation marker', async () => {
    mocks.count.mockResolvedValue(K + 5);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K));
    mocks.deleteMany.mockResolvedValue({ count: 5 });
    mocks.findFirst.mockResolvedValueOnce({ id: 'existing-marker' });

    await publishTaskEvent('task-1', 'log', { line: 'x' });

    const markerCreates = mocks.create.mock.calls.filter((call) => {
      const data = call[0] as { data: { payload: { line?: string } } };
      return data.data.payload?.line === MARKER_LINE;
    });
    expect(markerCreates).toHaveLength(0);
  });

  it('does not create a marker when deleteMany removes nothing', async () => {
    mocks.count.mockResolvedValue(K + 1);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K));
    mocks.deleteMany.mockResolvedValue({ count: 0 });

    await publishTaskEvent('task-1', 'log', { line: 'x' });

    expect(mocks.create).toHaveBeenCalledTimes(1); // only the original event
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('ensureTruncationMarker TOCTOU safety', () => {
  it('runs the marker check-and-create inside a transaction', async () => {
    mocks.count.mockResolvedValue(K + 5);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K));
    mocks.deleteMany.mockResolvedValue({ count: 5 });
    mocks.findFirst.mockResolvedValueOnce(null);
    mocks.create.mockResolvedValue({
      id: 'marker',
      kind: 'log',
      payload: { line: MARKER_LINE },
      createdAt: new Date(),
    });

    await publishTaskEvent('task-1', 'log', { line: 'x' });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('acquires the advisory lock before checking for an existing marker', async () => {
    const callOrder: string[] = [];
    mocks.count.mockResolvedValue(K + 5);
    mocks.findMany.mockResolvedValueOnce(survivorIds(K));
    mocks.deleteMany.mockResolvedValue({ count: 5 });
    mocks.queryRaw.mockImplementation(async () => {
      callOrder.push('lock');
    });
    mocks.findFirst.mockImplementationOnce(async () => {
      callOrder.push('check');
      return null;
    });
    mocks.create
      .mockImplementationOnce(async () => ({
        id: 'evt',
        kind: 'log',
        payload: {},
        createdAt: new Date(),
      }))
      .mockImplementationOnce(async () => {
        callOrder.push('create');
        return {
          id: 'marker',
          kind: 'log',
          payload: { line: MARKER_LINE },
          createdAt: new Date(),
        };
      });

    await publishTaskEvent('task-1', 'log', { line: 'x' });

    expect(callOrder).toEqual(['lock', 'check', 'create']);
  });
});
