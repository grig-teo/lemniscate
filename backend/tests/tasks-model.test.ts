import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { modelSwitchBlocker } from '../src/routes/tasks.js';

// Locking tests for POST /tasks/:id/model — the mid-run model switch behind
// the console footer's active-model dropdown. The new config id is stored on
// the task; a queued run resolves it at start, a running / reviewing_code run
// picks it up between LLM calls (applyPendingModelSwitch in agent-runtime.ts).

describe('modelSwitchBlocker', () => {
  it.each(['queued', 'running', 'reviewing_code'])('allows a %s task', (status) => {
    expect(modelSwitchBlocker({ status })).toBeNull();
  });

  it.each(['pending', 'awaiting_review', 'done', 'failed', 'closed'])(
    'rejects tasks that are %s',
    (status) => {
      expect(modelSwitchBlocker({ status })).toBe(
        `task is ${status} — the model can only be switched while queued, running, or reviewing code`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// HTTP integration: POST /api/tasks/:id/model through the registered route.
// The target config must belong to the user and be enabled; the task keeps
// its status (the switch is advisory, applied between LLM calls).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  taskUpdate: vi.fn(),
  llmConfigFindFirst: vi.fn(),
  publishTaskEvent: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    task: { findFirst: mocks.taskFindFirst, update: mocks.taskUpdate },
    llmConfig: { findFirst: mocks.llmConfigFindFirst },
  },
}));
vi.mock('../src/lib/task-events.js', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
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

const AUTH = { cookies: { lemniscate_token: signAuthToken('user-1', 0) } } as const;

function switchModel(
  app: Awaited<ReturnType<typeof buildApp>>,
  body: unknown = { llmConfigId: 'cfg-2' },
  taskId = 't1',
) {
  return app.inject({ method: 'POST', url: `/api/tasks/${taskId}/model`, payload: body, ...AUTH });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.taskFindFirst.mockResolvedValue({ id: 't1', status: 'running' });
  mocks.llmConfigFindFirst.mockResolvedValue({ id: 'cfg-2', name: 'Anthropic', model: 'claude-sonnet-4-5' });
  mocks.taskUpdate.mockResolvedValue({ id: 't1', status: 'running', llmConfigId: 'cfg-2' });
  mocks.publishTaskEvent.mockResolvedValue(undefined);
});

describe('POST /api/tasks/:id/model', () => {
  it('stores the new config id and logs the switch request', async () => {
    const app = await buildApp();

    const response = await switchModel(app);

    expect(response.statusCode).toBe(200);
    expect(mocks.llmConfigFindFirst).toHaveBeenCalledWith({
      where: { id: 'cfg-2', userId: 'user-1', enabled: true },
      select: { id: true, name: true, model: true },
    });
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { llmConfigId: 'cfg-2' },
    });
    expect(response.json().task.llmConfigId).toBe('cfg-2');
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith(
      't1',
      'log',
      expect.objectContaining({ line: expect.stringContaining('claude-sonnet-4-5') }),
    );
  });

  it('returns 404 when the task does not exist', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    const app = await buildApp();

    const response = await switchModel(app);

    expect(response.statusCode).toBe(404);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when the task is not in flight', async () => {
    mocks.taskFindFirst.mockResolvedValue({ id: 't1', status: 'done' });
    const app = await buildApp();

    const response = await switchModel(app);

    expect(response.statusCode).toBe(400);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when the config is missing, foreign, or disabled', async () => {
    mocks.llmConfigFindFirst.mockResolvedValue(null);
    const app = await buildApp();

    const response = await switchModel(app);

    expect(response.statusCode).toBe(400);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid body', async () => {
    const app = await buildApp();

    const response = await switchModel(app, {});

    expect(response.statusCode).toBe(400);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });
});
