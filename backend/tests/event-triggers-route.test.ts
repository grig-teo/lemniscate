import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route-level tests for the EventTrigger CRUD endpoints. Prisma is mocked;
// auth uses a real signed cookie (same pattern as connections-security.test.ts).

const mocks = vi.hoisted(() => ({
  repoFindFirst: vi.fn(),
  triggerFindMany: vi.fn(),
  triggerCreate: vi.fn(),
  triggerUpdateMany: vi.fn(),
  triggerDeleteMany: vi.fn(),
  triggerFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    repository: { findFirst: mocks.repoFindFirst },
    eventTrigger: {
      findMany: mocks.triggerFindMany,
      create: mocks.triggerCreate,
      updateMany: mocks.triggerUpdateMany,
      deleteMany: mocks.triggerDeleteMany,
      findUnique: mocks.triggerFindUnique,
    },
    user: { findUnique: mocks.userFindUnique },
  },
}));

vi.mock('../src/lib/event-trigger-handler.js', () => ({
  TRIGGERABLE_EVENT_KINDS: ['ci_failed', 'issue_opened'],
  fireEventTrigger: vi.fn(),
}));

vi.mock('../src/lib/proposal-scheduler.js', () => ({
  enqueueRunTask: vi.fn(),
  enqueueMergeGate: vi.fn(),
  getAgentTasksQueue: vi.fn(),
}));

vi.mock('../src/lib/metrics.js', () => ({
  metrics: { observeJob: vi.fn(), render: vi.fn(() => '') },
  registerHttpMetricsHook: vi.fn(),
  registerMetricsRoute: vi.fn(),
}));

vi.mock('../src/lib/sentry.js', () => ({
  initErrorReporting: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('ioredis', () => ({ Redis: vi.fn() }));

import eventTriggersRoutes from '../src/routes/event-triggers.js';
import { signAuthToken } from '../src/plugins/auth.js';

const REPO_ID = 'repo-1';
const TRIGGER_ID = 'trigger-1';

function sampleTrigger(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TRIGGER_ID,
    repositoryId: REPO_ID,
    eventKind: 'ci_failed',
    taskPrompt: 'Fix the CI failure',
    enabled: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(eventTriggersRoutes, { prefix: '/api' });
  return app;
}

function authCookie(userId = 'user-1', sv = 0): Record<string, string> {
  mocks.userFindUnique.mockResolvedValue({ id: userId, sessionVersion: sv });
  return { lemniscate_token: signAuthToken(userId, sv) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repoFindFirst.mockResolvedValue({ id: REPO_ID });
});

describe('GET /api/repositories/:id/triggers', () => {
  it('returns the list of triggers for an owned repository', async () => {
    mocks.triggerFindMany.mockResolvedValue([sampleTrigger()]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/repositories/${REPO_ID}/triggers`,
      cookies: authCookie(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().triggers).toHaveLength(1);
    expect(res.json().triggers[0].eventKind).toBe('ci_failed');
    await app.close();
  });

  it('returns 404 when the repository is not owned by the user', async () => {
    mocks.repoFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/repositories/${REPO_ID}/triggers`,
      cookies: authCookie(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /api/repositories/:id/triggers', () => {
  it('creates a trigger and returns 201', async () => {
    mocks.triggerCreate.mockResolvedValue(sampleTrigger());
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/repositories/${REPO_ID}/triggers`,
      cookies: authCookie(),
      payload: { eventKind: 'ci_failed', taskPrompt: 'Fix the CI failure' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().trigger.eventKind).toBe('ci_failed');
    expect(mocks.triggerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repositoryId: REPO_ID,
        eventKind: 'ci_failed',
        taskPrompt: 'Fix the CI failure',
        enabled: true,
      }),
    });
    await app.close();
  });

  it('returns 409 on duplicate event kind (unique constraint)', async () => {
    mocks.triggerCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '6.0.0',
      }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/repositories/${REPO_ID}/triggers`,
      cookies: authCookie(),
      payload: { eventKind: 'ci_failed', taskPrompt: 'Fix the CI failure' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 400 on invalid event kind', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/repositories/${REPO_ID}/triggers`,
      cookies: authCookie(),
      payload: { eventKind: 'invalid_kind', taskPrompt: 'Fix it' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 on empty taskPrompt', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/repositories/${REPO_ID}/triggers`,
      cookies: authCookie(),
      payload: { eventKind: 'ci_failed', taskPrompt: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('PATCH /api/repositories/:id/triggers/:triggerId', () => {
  it('updates the trigger prompt and enabled flag', async () => {
    mocks.triggerUpdateMany.mockResolvedValue({ count: 1 });
    mocks.triggerFindUnique.mockResolvedValue(sampleTrigger({ taskPrompt: 'Updated prompt', enabled: false }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/repositories/${REPO_ID}/triggers/${TRIGGER_ID}`,
      cookies: authCookie(),
      payload: { taskPrompt: 'Updated prompt', enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().trigger.taskPrompt).toBe('Updated prompt');
    expect(res.json().trigger.enabled).toBe(false);
    await app.close();
  });

  it('returns 404 when the trigger does not exist', async () => {
    mocks.triggerUpdateMany.mockResolvedValue({ count: 0 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/repositories/${REPO_ID}/triggers/${TRIGGER_ID}`,
      cookies: authCookie(),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('DELETE /api/repositories/:id/triggers/:triggerId', () => {
  it('deletes the trigger and returns 204', async () => {
    mocks.triggerDeleteMany.mockResolvedValue({ count: 1 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/repositories/${REPO_ID}/triggers/${TRIGGER_ID}`,
      cookies: authCookie(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('returns 404 when the trigger does not exist', async () => {
    mocks.triggerDeleteMany.mockResolvedValue({ count: 0 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/repositories/${REPO_ID}/triggers/${TRIGGER_ID}`,
      cookies: authCookie(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
