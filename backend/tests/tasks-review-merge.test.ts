import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeBlocker, reviewBlocker } from '../src/routes/tasks.js';

// Locking tests for the manual review/merge trigger eligibility (reviewBlocker,
// mergeBlocker) and the HTTP handlers (POST /tasks/:id/review, /merge).

// ---------------------------------------------------------------------------
// Pure eligibility rules
// ---------------------------------------------------------------------------

describe('reviewBlocker', () => {
  it('allows an awaiting_review task with a branch', () => {
    expect(reviewBlocker({ status: 'awaiting_review', branchName: 'lemniscate/t-1' })).toBeNull();
  });

  it('allows a reviewing_code task with a branch (idempotent re-trigger)', () => {
    expect(reviewBlocker({ status: 'reviewing_code', branchName: 'lemniscate/t-1' })).toBeNull();
  });

  it('rejects an awaiting_review task without a branch', () => {
    expect(reviewBlocker({ status: 'awaiting_review', branchName: null })).toBe(
      'task has no branch to review',
    );
  });

  it.each(['pending', 'queued', 'running', 'done', 'failed', 'closed'])(
    'rejects tasks that are %s',
    (status) => {
      expect(reviewBlocker({ status, branchName: 'lemniscate/t-1' })).toBe(
        `task is ${status}, not awaiting_review`,
      );
    },
  );
});

describe('mergeBlocker', () => {
  it('allows an awaiting_review task with a branch', () => {
    expect(mergeBlocker({ status: 'awaiting_review', branchName: 'lemniscate/t-1' })).toBeNull();
  });

  it('allows a reviewing_code task with a branch', () => {
    expect(mergeBlocker({ status: 'reviewing_code', branchName: 'lemniscate/t-1' })).toBeNull();
  });

  it('rejects without a branch', () => {
    expect(mergeBlocker({ status: 'awaiting_review', branchName: null })).toBe(
      'task has no branch to merge',
    );
  });

  it.each(['pending', 'queued', 'running', 'done', 'failed', 'closed'])(
    'rejects tasks that are %s',
    (status) => {
      expect(mergeBlocker({ status, branchName: 'lemniscate/t-1' })).toBe(
        `task is ${status}, not awaiting_review`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// HTTP integration: POST /api/tasks/:id/review and /merge
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  enqueueReviewTask: vi.fn(),
  enqueueMergeGate: vi.fn(),
  setTaskStatus: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    task: { findFirst: mocks.taskFindFirst },
  },
}));
vi.mock('../src/lib/proposal-scheduler.js', () => ({
  enqueueReviewTask: mocks.enqueueReviewTask,
  enqueueMergeGate: mocks.enqueueMergeGate,
  getAgentTasksQueue: () => ({ add: vi.fn() }),
  JOB_PRIORITY: { userTask: 1, review: 2, background: 10 },
}));
vi.mock('../src/lib/task-events.js', () => ({
  setTaskStatus: mocks.setTaskStatus,
  publishTaskEvent: vi.fn(),
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

const taskAwaiting = {
  id: 't1',
  status: 'awaiting_review',
  branchName: 'lemniscate/t-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.enqueueReviewTask.mockResolvedValue(undefined);
  mocks.enqueueMergeGate.mockResolvedValue(undefined);
  mocks.setTaskStatus.mockResolvedValue(undefined);
});

describe('POST /api/tasks/:id/review', () => {
  it('sets reviewing_code and enqueues a review-pr job (202)', async () => {
    mocks.taskFindFirst.mockResolvedValue(taskAwaiting);
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/t1/review',
      ...AUTH,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ enqueued: true });
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('t1', 'reviewing_code');
    expect(mocks.enqueueReviewTask).toHaveBeenCalledWith('t1', 0);
  });

  it('returns 404 when the task does not exist', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/xx/review', ...AUTH });

    expect(res.statusCode).toBe(404);
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
  });

  it('returns 400 when the task is done (no open PR)', async () => {
    mocks.taskFindFirst.mockResolvedValue({ ...taskAwaiting, status: 'done' });
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/t1/review', ...AUTH });

    expect(res.statusCode).toBe(400);
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/merge', () => {
  it('enqueues a merge-gate job (202)', async () => {
    mocks.taskFindFirst.mockResolvedValue(taskAwaiting);
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/t1/merge',
      ...AUTH,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ enqueued: true });
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('t1', 0, 0);
  });

  it('returns 400 when the task is already done', async () => {
    mocks.taskFindFirst.mockResolvedValue({ ...taskAwaiting, status: 'done' });
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/t1/merge', ...AUTH });

    expect(res.statusCode).toBe(400);
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });
});
