import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks for the task-events route dependencies: prisma (task + taskEvent
// queries), auth (authenticatedUserId), helpers (parseOrReply), and
// task-lifecycle (ownedTaskWhere, wantsSse). No real DB or Fastify server
// is started — the handler is called directly with fake request/reply.

const mocks = vi.hoisted(() => ({
  taskFindFirst: vi.fn(),
  taskEventFindMany: vi.fn(),
  authenticatedUserId: vi.fn(),
  parseOrReply: vi.fn(),
  ownedTaskWhere: vi.fn(),
  wantsSse: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    task: { findFirst: mocks.taskFindFirst },
    taskEvent: { findMany: mocks.taskEventFindMany },
  },
}));
vi.mock('../src/plugins/auth.js', () => ({ authenticatedUserId: mocks.authenticatedUserId }));
vi.mock('../src/routes/helpers.js', () => ({ parseOrReply: mocks.parseOrReply }));
vi.mock('../src/routes/task-lifecycle.js', () => ({
  ownedTaskWhere: mocks.ownedTaskWhere,
  wantsSse: mocks.wantsSse,
}));

import { getTaskEvents } from '../src/routes/task-events-stream.js';
import { serializeTaskEvent } from '../src/lib/task-events.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticatedUserId.mockReturnValue('user-1');
  mocks.parseOrReply.mockReturnValue({ id: 'task-1' });
  mocks.ownedTaskWhere.mockReturnValue({ id: 'task-1', userId: 'user-1' });
  mocks.wantsSse.mockReturnValue(false);
  mocks.taskFindFirst.mockResolvedValue({ id: 'task-1' });
});

function fakeRequest(overrides: Record<string, unknown> = {}): object {
  return {
    params: { id: 'task-1' },
    headers: { accept: 'application/json' },
    ...overrides,
  };
}

function fakeReply(): { code: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const code = vi.fn().mockReturnValue({ send });
  return { code, send };
}

describe('GET /api/tasks/:id/events (JSON)', () => {
  it('returns serialized events in ascending order', async () => {
    const now = Date.now();
    // findMany returns desc order; the handler reverses to asc.
    mocks.taskEventFindMany.mockResolvedValue([
      { id: 'e3', kind: 'log', payload: { line: 'third' }, createdAt: new Date(now + 2000) },
      { id: 'e2', kind: 'log', payload: { line: 'second' }, createdAt: new Date(now + 1000) },
      { id: 'e1', kind: 'log', payload: { line: 'first' }, createdAt: new Date(now) },
    ]);
    const result = await getTaskEvents(fakeRequest() as never, fakeReply() as never);
    expect(result).toEqual([
      serializeTaskEvent({ id: 'e1', kind: 'log', payload: { line: 'first' }, createdAt: new Date(now) }),
      serializeTaskEvent({ id: 'e2', kind: 'log', payload: { line: 'second' }, createdAt: new Date(now + 1000) }),
      serializeTaskEvent({ id: 'e3', kind: 'log', payload: { line: 'third' }, createdAt: new Date(now + 2000) }),
    ]);
  });

  it('queries with desc ordering and a take limit (HISTORY_TAKE)', async () => {
    mocks.taskEventFindMany.mockResolvedValue([]);
    await getTaskEvents(fakeRequest() as never, fakeReply() as never);
    expect(mocks.taskEventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: 'desc' },
        take: expect.any(Number),
      }),
    );
    const call = mocks.taskEventFindMany.mock.calls[0][0];
    expect(call.take).toBeGreaterThan(0);
  });

  it('returns 404 when the task does not exist', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    const reply = fakeReply();
    await getTaskEvents(fakeRequest() as never, reply as never);
    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Task not found' });
  });

  it('does not query events when the task is missing', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    await getTaskEvents(fakeRequest() as never, fakeReply() as never);
    expect(mocks.taskEventFindMany).not.toHaveBeenCalled();
  });
});
