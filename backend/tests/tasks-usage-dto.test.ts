import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for the task DTO usage fields: list/get responses expose the
// persisted llmTokensUsed (+ prompt/completion split) and the EFFECTIVE
// maxTokensPerRun (task config → repo config → user default), plus an
// estimated cost only when the effective config has prices.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  taskFindFirst: vi.fn(),
  repoFindMany: vi.fn(),
  llmFindMany: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    task: { findMany: mocks.taskFindMany, findFirst: mocks.taskFindFirst },
    repository: { findMany: mocks.repoFindMany },
    llmConfig: { findMany: mocks.llmFindMany },
  },
}));

import tasksRoutes from '../src/routes/tasks.js';
import { signAuthToken } from '../src/plugins/auth.js';

const PRICED_CONFIG = {
  id: 'cfg-priced',
  isDefault: false,
  maxTokensPerRun: 500_000,
  inputPricePerMillion: 2,
  outputPricePerMillion: 10,
};
const DEFAULT_CONFIG = {
  id: 'cfg-default',
  isDefault: true,
  maxTokensPerRun: 250_000,
  inputPricePerMillion: null,
  outputPricePerMillion: null,
};

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    repositoryId: 'repo-1',
    kind: 'prompt',
    title: 'do things',
    status: 'running',
    llmConfigId: 'cfg-priced',
    llmTokensUsed: 1500,
    llmPromptTokens: 1000,
    llmCompletionTokens: 500,
    archivedAt: null,
    createdAt: new Date('2026-07-20T10:00:00Z'),
    updatedAt: new Date('2026-07-20T11:00:00Z'),
    ...overrides,
  };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(tasksRoutes, { prefix: '/api' });
  return app;
}

function authed(app: Awaited<ReturnType<typeof buildApp>>, url: string) {
  return app.inject({
    method: 'GET',
    url,
    cookies: { lemniscate_token: signAuthToken('user-1', 0) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.taskFindMany.mockResolvedValue([taskRow()]);
  mocks.repoFindMany.mockResolvedValue([{ id: 'repo-1', llmConfigId: null }]);
  mocks.llmFindMany.mockResolvedValue([PRICED_CONFIG, DEFAULT_CONFIG]);
  mocks.taskFindFirst.mockResolvedValue(taskRow({ repository: { id: 'repo-1', llmConfigId: null } }));
});

describe('GET /api/tasks usage fields', () => {
  it('includes token usage, the effective budget, and the estimated cost', async () => {
    const app = await buildApp();
    const response = await authed(app, '/api/tasks');
    expect(response.statusCode).toBe(200);
    const [task] = response.json().tasks;
    expect(task.llmTokensUsed).toBe(1500);
    expect(task.llmPromptTokens).toBe(1000);
    expect(task.llmCompletionTokens).toBe(500);
    expect(task.maxTokensPerRun).toBe(500_000);
    expect(task.estimatedCostUsd).toBe(0.007);
  });

  it('falls back to the repository config for the effective budget', async () => {
    mocks.taskFindMany.mockResolvedValue([taskRow({ llmConfigId: null })]);
    mocks.repoFindMany.mockResolvedValue([{ id: 'repo-1', llmConfigId: 'cfg-default' }]);
    const app = await buildApp();
    const [task] = (await authed(app, '/api/tasks')).json().tasks;
    expect(task.maxTokensPerRun).toBe(250_000);
    expect('estimatedCostUsd' in task).toBe(false);
  });

  it('omits the cost when the split is unknown and reports a null budget without configs', async () => {
    mocks.taskFindMany.mockResolvedValue([
      taskRow({ llmConfigId: null, llmPromptTokens: null, llmCompletionTokens: null }),
    ]);
    mocks.llmFindMany.mockResolvedValue([]);
    const app = await buildApp();
    const [task] = (await authed(app, '/api/tasks')).json().tasks;
    expect(task.llmTokensUsed).toBe(1500);
    expect(task.maxTokensPerRun).toBeNull();
    expect('estimatedCostUsd' in task).toBe(false);
  });
});

describe('GET /api/tasks/:id usage fields', () => {
  it('includes token usage and the effective budget', async () => {
    const app = await buildApp();
    const response = await authed(app, '/api/tasks/task-1');
    expect(response.statusCode).toBe(200);
    const { task } = response.json();
    expect(task.llmTokensUsed).toBe(1500);
    expect(task.maxTokensPerRun).toBe(500_000);
    expect(task.estimatedCostUsd).toBe(0.007);
  });
});
