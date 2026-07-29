import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { patchBodySchema } from '../src/routes/tasks.js';

// Locking tests for PATCH /api/tasks/:id — the endpoint that saves edits on a
// pending proposal/prompt WITHOUT starting it. This suite pins the body schema
// (incl. the per-task llmConfigId override exercised by the proposal/prompt
// detail's bottom model dropdown) and the HTTP behavior through the registered
// route: the model override's ownership+enabled check, the gating via
// startBlocker (pending-only), and the 404 path.

const CONFIG_ROW = { id: 'cfg-2', name: 'Anthropic', model: 'claude-sonnet-4-5' };

describe('patchBodySchema', () => {
  it('accepts an empty body', () => {
    expect(patchBodySchema.parse({})).toEqual({});
  });

  it('accepts title and prompt edits', () => {
    expect(patchBodySchema.parse({ title: 'T', prompt: 'P' })).toEqual({ title: 'T', prompt: 'P' });
  });

  it('accepts an llmConfigId override', () => {
    expect(patchBodySchema.parse({ llmConfigId: 'cfg-2' })).toEqual({ llmConfigId: 'cfg-2' });
  });

  it('rejects an empty llmConfigId', () => {
    expect(patchBodySchema.safeParse({ llmConfigId: '' }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(patchBodySchema.safeParse({ status: 'done' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration: PATCH /api/tasks/:id through the registered route. The
// target config (when llmConfigId is sent) must belong to the user and be
// enabled, mirroring POST /tasks/:id/model's permission check; only pending
// proposal/prompt tasks are editable (startBlocker).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  taskUpdate: vi.fn(),
  llmConfigFindFirst: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    task: { findFirst: mocks.taskFindFirst, update: mocks.taskUpdate },
    llmConfig: { findFirst: mocks.llmConfigFindFirst },
  },
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

function patchTask(
  app: Awaited<ReturnType<typeof buildApp>>,
  body: unknown = { llmConfigId: 'cfg-2' },
  taskId = 't1',
) {
  return app.inject({ method: 'PATCH', url: `/api/tasks/${taskId}`, payload: body, ...AUTH });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.taskFindFirst.mockResolvedValue({ id: 't1', kind: 'proposal', status: 'pending' });
  mocks.llmConfigFindFirst.mockResolvedValue(CONFIG_ROW);
  mocks.taskUpdate.mockResolvedValue({ id: 't1', status: 'pending', llmConfigId: 'cfg-2' });
});

describe('PATCH /api/tasks/:id — llmConfigId override', () => {
  it('verifies, stores, and returns the new llmConfigId', async () => {
    const app = await buildApp();

    const response = await patchTask(app);

    expect(response.statusCode).toBe(200);
    expect(mocks.llmConfigFindFirst).toHaveBeenCalledWith({
      where: { id: 'cfg-2', userId: 'user-1', enabled: true },
      select: { id: true, name: true, model: true },
    });
    expect(mocks.taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 't1' },
        data: expect.objectContaining({ llmConfigId: 'cfg-2' }),
      }),
    );
    expect(response.json().task.llmConfigId).toBe('cfg-2');
  });

  it('returns 400 when the config is missing, foreign, or disabled', async () => {
    mocks.llmConfigFindFirst.mockResolvedValue(null);
    const app = await buildApp();

    const response = await patchTask(app);

    expect(response.statusCode).toBe(400);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('does not touch llmConfigId when the field is absent', async () => {
    const app = await buildApp();

    const response = await patchTask(app, { title: 'New title' });

    expect(response.statusCode).toBe(200);
    expect(mocks.llmConfigFindFirst).not.toHaveBeenCalled();
    expect(mocks.taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 't1' },
        data: expect.not.objectContaining({ llmConfigId: expect.anything() }),
      }),
    );
  });

  it('returns 404 when the task does not exist', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    const app = await buildApp();

    const response = await patchTask(app);

    expect(response.statusCode).toBe(404);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when the task is not pending', async () => {
    mocks.taskFindFirst.mockResolvedValue({ id: 't1', kind: 'prompt', status: 'done' });
    const app = await buildApp();

    const response = await patchTask(app);

    expect(response.statusCode).toBe(400);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });
});