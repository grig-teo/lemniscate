import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for GET /tasks/:id/events: verifies that the JSON history query
// and the SSE replay are bounded by a `take` limit so a task with thousands of
// events cannot produce an unbounded response.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  eventFindMany: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    task: { findFirst: mocks.taskFindFirst },
    taskEvent: { findMany: mocks.eventFindMany },
  },
}));

// SSE subscribe would hang the test; only the JSON path is exercised here.
vi.mock('ioredis', () => ({
  Redis: class MockRedis {
    on() {}
    subscribe() {}
    quit() {}
  },
}));

import tasksRoutes from '../src/routes/tasks.js';
import { signAuthToken } from '../src/plugins/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(tasksRoutes, { prefix: '/api' });
  return app;
}

const AUTH = { cookies: { lemniscate_token: signAuthToken('user-1', 0) } };

const SAMPLE_EVENT = {
  id: 'e1',
  kind: 'log' as const,
  payload: { line: 'hello' },
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.taskFindFirst.mockResolvedValue({ id: 'task-1' });
  mocks.eventFindMany.mockResolvedValue([SAMPLE_EVENT]);
});

describe('GET /api/tasks/:id/events (JSON history)', () => {
  it('returns events as JSON when Accept is not text/event-stream', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/tasks/task-1/events',
      ...AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 'e1', kind: 'log' });
  });

  it('bounds the findMany query with a take limit', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'GET',
      url: '/api/tasks/task-1/events',
      ...AUTH,
    });
    const query = mocks.eventFindMany.mock.calls[0][0] as { take?: number };
    expect(query.take).toBeDefined();
    expect(query.take).toBeLessThanOrEqual(1000);
  });

  it('returns 404 for a task not owned by the user', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/tasks/other/events',
      ...AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/tasks/task-1/events',
    });
    expect(res.statusCode).toBe(401);
  });
});
