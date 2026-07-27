import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closePrBlocker } from '../src/routes/tasks.js';

// Locking tests for POST /tasks/:id/close-pr eligibility: only tasks that are
// awaiting_review with an open PR (branchName set) can be closed and have
// their branch deleted from the UI. The provider calls and DB writes are
// exercised in the handler; this pins the pure eligibility rule.

describe('closePrBlocker', () => {
  it('allows an awaiting_review task with a branch', () => {
    expect(closePrBlocker({ status: 'awaiting_review', branchName: 'lemniscate/t-1' })).toBeNull();
  });

  it('allows a reviewing_code task with a branch', () => {
    expect(closePrBlocker({ status: 'reviewing_code', branchName: 'lemniscate/t-1' })).toBeNull();
  });

  it('rejects an awaiting_review task without a branch', () => {
    expect(closePrBlocker({ status: 'awaiting_review', branchName: null })).toBe(
      'task has no branch to close',
    );
  });

  it.each(['pending', 'queued', 'running', 'done', 'failed', 'closed'])(
    'rejects tasks that are %s',
    (status) => {
      expect(closePrBlocker({ status, branchName: 'lemniscate/t-1' })).toBe(
        `task is ${status}, not awaiting_review`,
      );
    },
  );

  it('rejects a closed task even when it also lacks a branch', () => {
    // Edge case: a closed PR already deleted its branch — the status check
    // fires first (closed is not awaiting_review) so the branchName null
    // never matters.
    expect(closePrBlocker({ status: 'closed', branchName: null })).toBe(
      'task is closed, not awaiting_review',
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP integration: POST /api/tasks/:id/close-pr through the registered route.
// The route must be bound (issue: handler was imported but never registered),
// the provider close+deleteBranch calls must fire, and the task must flip to
// 'closed' via applyTaskPrState.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  taskFindUniqueOrThrow: vi.fn(),
  closePullRequest: vi.fn(),
  deleteBranch: vi.fn(),
  applyTaskPrState: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    task: { findFirst: mocks.taskFindFirst, findUniqueOrThrow: mocks.taskFindUniqueOrThrow },
  },
}));
vi.mock('../src/lib/pull-requests.js', () => ({
  closePullRequest: mocks.closePullRequest,
  deleteBranch: mocks.deleteBranch,
}));
vi.mock('../src/lib/pr-merged-handler.js', () => ({
  applyTaskPrState: mocks.applyTaskPrState,
}));
vi.mock('../src/lib/proposal-scheduler.js', () => ({
  getAgentTasksQueue: () => ({ add: vi.fn() }),
  enqueueRunTask: vi.fn(),
  JOB_PRIORITY: { userTask: 1, review: 2, background: 10 },
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

const taskWithRepo = {
  id: 't1',
  title: 'Fix bug',
  status: 'awaiting_review',
  branchName: 'lemniscate/t-1',
  prUrl: 'https://github.com/ivan/repo/pull/7',
  repository: {
    fullName: 'ivan/repo',
    defaultBranch: 'main',
    connection: { provider: 'github', userId: 'user-1' },
  },
};

function closePr(app: Awaited<ReturnType<typeof buildApp>>, taskId = 't1') {
  return app.inject({ method: 'POST', url: `/api/tasks/${taskId}/close-pr`, ...AUTH });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.closePullRequest.mockResolvedValue(undefined);
  mocks.deleteBranch.mockResolvedValue(undefined);
  mocks.applyTaskPrState.mockResolvedValue(true);
});

describe('POST /api/tasks/:id/close-pr', () => {
  it('closes the PR, deletes the branch, and flips the task to closed', async () => {
    mocks.taskFindFirst.mockResolvedValue(taskWithRepo);
    mocks.taskFindUniqueOrThrow.mockResolvedValue({ ...taskWithRepo, status: 'closed' });
    const app = await buildApp();

    const response = await closePr(app);

    expect(response.statusCode).toBe(200);
    expect(mocks.closePullRequest).toHaveBeenCalledOnce();
    expect(mocks.closePullRequest).toHaveBeenCalledWith(
      taskWithRepo.repository.connection,
      expect.objectContaining({
        repoFullName: 'ivan/repo',
        headBranch: 'lemniscate/t-1',
        baseBranch: 'main',
      }),
    );
    expect(mocks.deleteBranch).toHaveBeenCalledOnce();
    expect(mocks.deleteBranch).toHaveBeenCalledWith(
      taskWithRepo.repository.connection,
      'ivan/repo',
      'lemniscate/t-1',
    );
    expect(mocks.applyTaskPrState).toHaveBeenCalledWith(taskWithRepo, 'closed');
    expect(response.json().task.status).toBe('closed');
  });

  it('returns 404 when the task does not exist', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    const app = await buildApp();

    const response = await closePr(app);

    expect(response.statusCode).toBe(404);
    expect(mocks.closePullRequest).not.toHaveBeenCalled();
  });

  it('returns 400 when the task is not awaiting_review', async () => {
    mocks.taskFindFirst.mockResolvedValue({ ...taskWithRepo, status: 'done' });
    const app = await buildApp();

    const response = await closePr(app);

    expect(response.statusCode).toBe(400);
    expect(mocks.closePullRequest).not.toHaveBeenCalled();
  });

  it('returns 502 when the provider close fails', async () => {
    mocks.taskFindFirst.mockResolvedValue(taskWithRepo);
    mocks.closePullRequest.mockRejectedValue(new Error('provider down'));
    const app = await buildApp();

    const response = await closePr(app);

    expect(response.statusCode).toBe(502);
    expect(mocks.deleteBranch).not.toHaveBeenCalled();
    expect(mocks.applyTaskPrState).not.toHaveBeenCalled();
  });

  it('still flips the task when branch deletion fails (best-effort)', async () => {
    mocks.taskFindFirst.mockResolvedValue(taskWithRepo);
    mocks.deleteBranch.mockRejectedValue(new Error('branch protected'));
    mocks.taskFindUniqueOrThrow.mockResolvedValue({ ...taskWithRepo, status: 'closed' });
    const app = await buildApp();

    const response = await closePr(app);

    expect(response.statusCode).toBe(200);
    expect(mocks.applyTaskPrState).toHaveBeenCalledWith(taskWithRepo, 'closed');
  });
});
