import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';

// Locking test for the per-user active-task cap on POST /api/tasks: once a
// user has TASK_MAX_ACTIVE_PER_USER (default 5) queued+running tasks, the
// next create is 429 — one runaway user cannot flood the worker queue.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  repoFindFirst: vi.fn(),
  llmFindFirst: vi.fn(),
  taskCount: vi.fn(),
  taskCreate: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    repository: { findFirst: mocks.repoFindFirst },
    llmConfig: { findFirst: mocks.llmFindFirst },
    task: { count: mocks.taskCount, create: mocks.taskCreate },
  },
}));
vi.mock('../src/lib/proposal-scheduler.js', () => ({
  getAgentTasksQueue: () => ({ add: mocks.queueAdd }),
  enqueueRunTask: vi.fn(),
}));

import tasksRoutes from '../src/routes/tasks.js';
import { signAuthToken } from '../src/plugins/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(tasksRoutes, { prefix: '/api' });
  return app;
}

function createTask(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({
    method: 'POST',
    url: '/api/tasks',
    cookies: { lemniscate_token: signAuthToken('user-1', 0) },
    payload: { repositoryId: 'repo-1', prompt: 'do the thing' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.repoFindFirst.mockResolvedValue({ id: 'repo-1', llmConfigId: 'cfg-1', skillSlugs: null });
  mocks.taskCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: 't1', ...data }));
  mocks.queueAdd.mockResolvedValue({});
});

describe('per-user active task cap', () => {
  it('429s the create that would exceed the limit', async () => {
    mocks.taskCount.mockResolvedValue(config.TASK_MAX_ACTIVE_PER_USER);
    const app = await buildApp();
    const response = await createTask(app);
    expect(response.statusCode).toBe(429);
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it('counts only the requester’s queued+running tasks', async () => {
    mocks.taskCount.mockResolvedValue(0);
    const app = await buildApp();
    await createTask(app);
    expect(mocks.taskCount).toHaveBeenCalledWith({
      where: {
        status: { in: ['queued', 'running'] },
        repository: { connection: { userId: 'user-1' } },
      },
    });
  });

  it('creates the task below the limit', async () => {
    mocks.taskCount.mockResolvedValue(config.TASK_MAX_ACTIVE_PER_USER - 1);
    const app = await buildApp();
    const response = await createTask(app);
    expect(response.statusCode).toBe(201);
    expect(mocks.taskCreate).toHaveBeenCalledOnce();
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });
});
