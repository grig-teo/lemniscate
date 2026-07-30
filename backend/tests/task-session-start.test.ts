import { beforeEach, describe, expect, it, vi } from 'vitest';

// Session-anchor semantics of setTaskStatus: one pipeline pass (run → review
// → merge gate) shares ONE session; entering an active status from an
// idle/terminal one starts a new session. The console elapsed timer anchors
// at sessionStartedAt, so a rerun must reset it while run → reviewing_code
// must keep it.

const mocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn().mockResolvedValue(undefined),
  eventCreate: vi.fn().mockResolvedValue({
    id: 'evt-1',
    kind: 'status',
    payload: {},
    createdAt: new Date(),
  }),
  eventCount: vi.fn().mockResolvedValue(0),
  eventFindFirst: vi.fn().mockResolvedValue(null),
  eventFindMany: vi.fn().mockResolvedValue([]),
  eventDeleteMany: vi.fn(),
  publish: vi.fn().mockResolvedValue('OK'),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    task: { findUnique: mocks.taskFindUnique, update: mocks.taskUpdate },
    taskEvent: {
      create: mocks.eventCreate,
      count: mocks.eventCount,
      findFirst: mocks.eventFindFirst,
      findMany: mocks.eventFindMany,
      deleteMany: mocks.eventDeleteMany,
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));
vi.mock('ioredis', () => ({ Redis: vi.fn() }));

import { setTaskStatus } from '../src/lib/task-events.js';

function updateData(): Record<string, unknown> {
  return (mocks.taskUpdate.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskUpdate.mockResolvedValue(undefined);
  mocks.eventCreate.mockResolvedValue({
    id: 'evt-1',
    kind: 'status',
    payload: {},
    createdAt: new Date(),
  });
});

describe('setTaskStatus session anchoring', () => {
  it('starts a session when a pending task begins running', async () => {
    mocks.taskFindUnique.mockResolvedValue({ status: 'pending', sessionStartedAt: null });

    await setTaskStatus('t1', 'running');

    expect(updateData().status).toBe('running');
    expect(updateData().sessionStartedAt).toBeInstanceOf(Date);
  });

  it('keeps the existing session when a run moves to code review', async () => {
    const sessionStart = new Date('2026-07-30T10:00:00Z');
    mocks.taskFindUnique.mockResolvedValue({ status: 'running', sessionStartedAt: sessionStart });

    await setTaskStatus('t1', 'reviewing_code');

    expect(updateData().sessionStartedAt).toBeUndefined();
  });

  it('keeps the session when a review finishes back to awaiting_review', async () => {
    const sessionStart = new Date('2026-07-30T10:00:00Z');
    mocks.taskFindUnique.mockResolvedValue({
      status: 'reviewing_code',
      sessionStartedAt: sessionStart,
    });

    await setTaskStatus('t1', 'awaiting_review');

    expect(updateData().sessionStartedAt).toBeUndefined();
  });

  it('starts a fresh session when a failed task is rerun', async () => {
    const oldSession = new Date('2026-07-29T10:00:00Z');
    mocks.taskFindUnique.mockResolvedValue({ status: 'failed', sessionStartedAt: oldSession });

    await setTaskStatus('t1', 'running');

    const started = updateData().sessionStartedAt as Date;
    expect(started).toBeInstanceOf(Date);
    expect(started.getTime()).toBeGreaterThan(oldSession.getTime());
  });

  it('starts a fresh session when a re-review begins from awaiting_review without one', async () => {
    // Legacy task mid-pipeline without the column set: anchor at the first
    // active transition we see.
    mocks.taskFindUnique.mockResolvedValue({ status: 'awaiting_review', sessionStartedAt: null });

    await setTaskStatus('t1', 'reviewing_code');

    expect(updateData().sessionStartedAt).toBeInstanceOf(Date);
  });

  it('does not touch the session anchor on terminal statuses', async () => {
    mocks.taskFindUnique.mockResolvedValue({
      status: 'awaiting_review',
      sessionStartedAt: new Date('2026-07-30T10:00:00Z'),
    });

    await setTaskStatus('t1', 'done');

    expect(updateData().sessionStartedAt).toBeUndefined();
  });
});
