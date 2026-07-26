import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks for prisma (taskEvent CRUD, $transaction, $executeRaw) and ioredis
// (publisher). No real DB or Redis is contacted.

const mocks = vi.hoisted(() => {
  const fns = {
    taskEventCreate: vi.fn(),
    taskEventCount: vi.fn(),
    taskEventFindMany: vi.fn(),
    taskEventDeleteMany: vi.fn(),
    txFindMany: vi.fn(),
    txDeleteMany: vi.fn(),
    txCreate: vi.fn(),
    executeRaw: vi.fn(),
    transaction: vi.fn(),
    redisPublish: vi.fn(),
    redisIncr: vi.fn(),
  };
  // Interactive-transaction client: taskEvent ops + $executeRaw for the
  // advisory lock.
  const tx = {
    taskEvent: { findMany: fns.txFindMany, deleteMany: fns.txDeleteMany, create: fns.txCreate },
    $executeRaw: fns.executeRaw,
  };
  return { ...fns, tx };
});

vi.mock('ioredis', () => ({
  Redis: class MockRedis {
    publish = mocks.redisPublish;
    incr = mocks.redisIncr;
  },
}));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    taskEvent: {
      create: mocks.taskEventCreate,
      count: mocks.taskEventCount,
      findMany: mocks.taskEventFindMany,
      deleteMany: mocks.taskEventDeleteMany,
    },
    $transaction: (cb: unknown) => mocks.transaction(cb),
    $executeRaw: mocks.executeRaw,
  },
}));

import { enforceEventCap, publishTaskEvent } from '../src/lib/task-events.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisPublish.mockResolvedValue(1);
  mocks.redisIncr.mockResolvedValue(64);
  mocks.taskEventCreate.mockResolvedValue({
    id: 'evt-1',
    kind: 'log',
    payload: { line: 'hello' },
    createdAt: new Date('2025-01-01T00:00:00Z'),
  });
  mocks.transaction.mockImplementation(async (cb: unknown) =>
    (cb as (tx: unknown) => Promise<unknown>)(mocks.tx),
  );
  mocks.executeRaw.mockResolvedValue(0);
  mocks.txFindMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
  mocks.txDeleteMany.mockResolvedValue({ count: 10 });
  mocks.txCreate.mockResolvedValue({});
});

describe('publishTaskEvent', () => {
  it('creates a TaskEvent row and publishes it to Redis', async () => {
    await publishTaskEvent('task-1', 'log', { line: 'hello' });
    expect(mocks.taskEventCreate).toHaveBeenCalledWith({
      data: { taskId: 'task-1', kind: 'log', payload: { line: 'hello' } },
    });
    expect(mocks.redisPublish).toHaveBeenCalledWith(
      'task-events:task-1',
      expect.stringContaining('"line":"hello"'),
    );
  });

  it('continues when Redis publish fails (DB is source of truth)', async () => {
    mocks.redisPublish.mockRejectedValue(new Error('Redis down'));
    await expect(publishTaskEvent('task-1', 'log', { line: 'ok' })).resolves.toBeUndefined();
    expect(mocks.taskEventCreate).toHaveBeenCalled();
  });
});

describe('enforceEventCap', () => {
  it('does nothing when event count is under the cap', async () => {
    mocks.taskEventCount.mockResolvedValue(100);
    await enforceEventCap('task-1');
    expect(mocks.taskEventCount).toHaveBeenCalledWith({ where: { taskId: 'task-1' } });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('truncates old events when count exceeds the cap', async () => {
    mocks.taskEventCount.mockResolvedValue(6000);
    await enforceEventCap('task-1');
    expect(mocks.transaction).toHaveBeenCalled();
  });

  it('takes an advisory lock before truncating', async () => {
    mocks.taskEventCount.mockResolvedValue(6000);
    await enforceEventCap('task-1');
    expect(mocks.executeRaw).toHaveBeenCalled();
  });

  it('keeps the newest events via a desc survivor query', async () => {
    mocks.taskEventCount.mockResolvedValue(6000);
    await enforceEventCap('task-1');
    expect(mocks.txFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: 'task-1' },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('deletes non-survivor events', async () => {
    mocks.taskEventCount.mockResolvedValue(6000);
    await enforceEventCap('task-1');
    expect(mocks.txDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: 'task-1', NOT: { id: { in: ['s1', 's2'] } } },
      }),
    );
  });

  it('inserts a truncation marker event', async () => {
    mocks.taskEventCount.mockResolvedValue(6000);
    await enforceEventCap('task-1');
    expect(mocks.txCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: 'task-1',
          kind: 'log',
        }),
      }),
    );
    const payload = mocks.txCreate.mock.calls[0][0].data.payload;
    expect(payload.truncated).toBe(true);
  });
});

describe('enforceEventCap modulo counter', () => {
  it('skips the COUNT query when the counter is not a multiple of 64', async () => {
    mocks.redisIncr.mockResolvedValue(10);
    await enforceEventCap('task-1');
    expect(mocks.taskEventCount).not.toHaveBeenCalled();
  });

  it('runs the COUNT query when the counter is a multiple of 64', async () => {
    mocks.redisIncr.mockResolvedValue(128);
    mocks.taskEventCount.mockResolvedValue(100);
    await enforceEventCap('task-1');
    expect(mocks.taskEventCount).toHaveBeenCalled();
  });

  it('falls back to always-checking when Redis INCR fails', async () => {
    mocks.redisIncr.mockRejectedValue(new Error('Redis down'));
    mocks.taskEventCount.mockResolvedValue(100);
    await enforceEventCap('task-1');
    expect(mocks.taskEventCount).toHaveBeenCalled();
  });
});
