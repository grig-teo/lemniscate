import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tests for the per-task event cap in publishTaskEvent: when the number of
// events for a task exceeds TASK_EVENT_MAX_PER_TASK, the oldest events are
// pruned and a single "earlier output truncated" marker is ensured.

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    taskEvent: {
      create: mocks.create,
      count: mocks.count,
      findFirst: mocks.findFirst,
      deleteMany: mocks.deleteMany,
    },
  },
}));

vi.mock('ioredis', () => ({
  Redis: class MockRedis {
    publish = mocks.publish;
  },
}));

import { config } from '../src/config.js';
import { publishTaskEvent } from '../src/lib/task-events.js';

const K = config.TASK_EVENT_MAX_PER_TASK;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'evt-id',
    kind: 'log',
    payload: data.payload,
    createdAt: new Date(),
  }));
  mocks.publish.mockResolvedValue('OK');
});

describe('publishTaskEvent per-task cap', () => {
  it('does not prune when the event count is within the cap', async () => {
    mocks.count.mockResolvedValue(K);

    await publishTaskEvent('task-1', 'log', { line: 'hello' });

    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it('prunes old events when the count exceeds the cap', async () => {
    mocks.count.mockResolvedValue(K + 10);
    const cutoff = new Date('2026-01-01T00:00:00Z');
    mocks.findFirst
      // boundary lookup (skip K-1)
      .mockResolvedValueOnce({ createdAt: cutoff })
      // marker existence check
      .mockResolvedValueOnce(null);
    mocks.deleteMany.mockResolvedValue({ count: 10 });
    // marker create
    mocks.create.mockResolvedValueOnce({
      id: 'marker',
      kind: 'log',
      payload: { line: '— earlier output truncated —' },
      createdAt: new Date(),
    });

    await publishTaskEvent('task-1', 'log', { line: 'overflow' });

    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { taskId: 'task-1', createdAt: { lt: cutoff } },
    });
  });

  it('inserts exactly one truncation marker when pruning removes rows', async () => {
    mocks.count.mockResolvedValue(K + 5);
    mocks.findFirst
      .mockResolvedValueOnce({ createdAt: new Date() }) // boundary
      .mockResolvedValueOnce(null); // marker not found
    mocks.deleteMany.mockResolvedValue({ count: 5 });
    mocks.create.mockResolvedValue({
      id: 'marker',
      kind: 'log',
      payload: { line: '— earlier output truncated —' },
      createdAt: new Date(),
    });

    await publishTaskEvent('task-1', 'log', { line: 'x' });

    const markerCreate = mocks.create.mock.calls.find(
      (call) => {
        const data = call[0] as { data: { payload: { line?: string } } };
        return data.data.payload?.line === '— earlier output truncated —';
      },
    );
    expect(markerCreate).toBeDefined();
  });

  it('does not insert a duplicate truncation marker', async () => {
    mocks.count.mockResolvedValue(K + 5);
    mocks.findFirst
      .mockResolvedValueOnce({ createdAt: new Date() }) // boundary
      .mockResolvedValueOnce({ id: 'existing-marker' }); // marker found
    mocks.deleteMany.mockResolvedValue({ count: 5 });

    await publishTaskEvent('task-1', 'log', { line: 'x' });

    const markerCreates = mocks.create.mock.calls.filter((call) => {
      const data = call[0] as { data: { payload: { line?: string } } };
      return data.data.payload?.line === '— earlier output truncated —';
    });
    expect(markerCreates).toHaveLength(0);
  });

  it('does not create a marker when deleteMany removes nothing', async () => {
    mocks.count.mockResolvedValue(K + 1);
    mocks.findFirst.mockResolvedValueOnce({ createdAt: new Date() });
    mocks.deleteMany.mockResolvedValue({ count: 0 });

    await publishTaskEvent('task-1', 'log', { line: 'x' });

    expect(mocks.create).toHaveBeenCalledTimes(1); // only the original event
  });
});
