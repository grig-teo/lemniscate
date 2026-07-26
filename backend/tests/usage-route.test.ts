import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for GET /api/usage: per-user token aggregation over a 7d/30d
// window, grouped by repository and by day, with estimated cost only when the
// LLM config has prices. Prisma is mocked; the fixtures below stand in for a
// seeded database.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  repoFindMany: vi.fn(),
  llmFindMany: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    task: { findMany: mocks.taskFindMany },
    repository: { findMany: mocks.repoFindMany },
    llmConfig: { findMany: mocks.llmFindMany },
  },
}));

import usageRoutes from '../src/routes/usage.js';
import { signAuthToken } from '../src/plugins/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(usageRoutes, { prefix: '/api' });
  return app;
}

function getUsage(app: Awaited<ReturnType<typeof buildApp>>, query = '') {
  return app.inject({
    method: 'GET',
    url: `/api/usage${query}`,
    cookies: { lemniscate_token: signAuthToken('user-1', 0) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.repoFindMany.mockResolvedValue([
    { id: 'repo-1', name: 'alpha', fullName: 'me/alpha', llmConfigId: null },
  ]);
  mocks.llmFindMany.mockResolvedValue([
    {
      id: 'cfg-1',
      isDefault: true,
      maxTokensPerRun: 500_000,
      inputPricePerMillion: 2,
      outputPricePerMillion: 10,
    },
  ]);
  mocks.taskFindMany.mockResolvedValue([
    {
      repositoryId: 'repo-1',
      createdAt: new Date('2026-07-20T10:00:00Z'),
      llmTokensUsed: 1500,
      llmPromptTokens: 1000,
      llmCompletionTokens: 500,
      llmConfigId: 'cfg-1',
    },
  ]);
});

describe('GET /api/usage', () => {
  it('requires authentication', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/usage' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unknown period', async () => {
    const app = await buildApp();
    const response = await getUsage(app, '?period=1y');
    expect(response.statusCode).toBe(400);
  });

  it('scopes the task window to the authenticated user and the period', async () => {
    const app = await buildApp();
    await getUsage(app, '?period=7d');
    const args = mocks.taskFindMany.mock.calls[0]?.[0];
    expect(args.where.repository).toEqual({ connection: { userId: 'user-1' } });
    const gte = args.where.createdAt.gte as Date;
    const ageMs = Date.now() - gte.getTime();
    expect(ageMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(ageMs).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  it('aggregates tokens per repository and per day with an estimated cost', async () => {
    const app = await buildApp();
    const response = await getUsage(app, '?period=30d');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.period).toBe('30d');
    expect(body.totals).toEqual({
      totalTokens: 1500,
      promptTokens: 1000,
      completionTokens: 500,
      // 1000 prompt @ $2/M + 500 completion @ $10/M
      estimatedCostUsd: 0.007,
    });
    expect(body.byRepository).toEqual([
      {
        repositoryId: 'repo-1',
        name: 'alpha',
        fullName: 'me/alpha',
        totalTokens: 1500,
        promptTokens: 1000,
        completionTokens: 500,
        estimatedCostUsd: 0.007,
      },
    ]);
    expect(body.byDay).toEqual([
      {
        day: '2026-07-20',
        totalTokens: 1500,
        promptTokens: 1000,
        completionTokens: 500,
        estimatedCostUsd: 0.007,
      },
    ]);
    expect(typeof body.semantics).toBe('string');
  });

  it('omits the cost fields entirely when no prices are configured', async () => {
    mocks.llmFindMany.mockResolvedValue([
      {
        id: 'cfg-1',
        isDefault: true,
        maxTokensPerRun: null,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
      },
    ]);
    const app = await buildApp();
    const body = (await getUsage(app)).json();
    expect('estimatedCostUsd' in body.totals).toBe(false);
    expect('estimatedCostUsd' in body.byRepository[0]).toBe(false);
    expect('estimatedCostUsd' in body.byDay[0]).toBe(false);
  });

  it('defaults to the 30d period', async () => {
    const app = await buildApp();
    const body = (await getUsage(app)).json();
    expect(body.period).toBe('30d');
  });
});
