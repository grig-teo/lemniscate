import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Readiness endpoint contract: /health stays a cheap liveness probe, while
// /health/ready performs a real Postgres `SELECT 1` and a Redis PING,
// returning 503 with per-dependency detail when either is down. prisma and
// the shared redis client are mocked so no DB/network is contacted.

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  ping: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock('../src/lib/redis.js', () => ({ getRedisClient: () => ({ ping: mocks.ping }) }));

import healthRoutes from '../src/routes/health.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(healthRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
  mocks.ping.mockResolvedValue('PONG');
});

describe('GET /health', () => {
  it('stays a static liveness probe that never touches dependencies', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('db down'));
    mocks.ping.mockRejectedValue(new Error('redis down'));

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.ping).not.toHaveBeenCalled();
  });
});

describe('GET /health/ready', () => {
  it('returns 200 with per-dependency detail when postgres and redis answer', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      dependencies: { postgres: { ok: true }, redis: { ok: true } },
    });
  });

  it('returns 503 naming postgres when the SELECT 1 probe rejects', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('connection refused'));

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.dependencies.postgres).toEqual({ ok: false, error: 'connection refused' });
    expect(body.dependencies.redis).toEqual({ ok: true });
  });

  it('returns 503 naming redis when PING rejects', async () => {
    mocks.ping.mockRejectedValue(new Error('Connection is closed'));

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.dependencies.postgres).toEqual({ ok: true });
    expect(body.dependencies.redis).toEqual({ ok: false, error: 'Connection is closed' });
  });

  it('reports both dependencies when both are down', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('db down'));
    mocks.ping.mockRejectedValue(new Error('redis down'));

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.dependencies.postgres.ok).toBe(false);
    expect(body.dependencies.redis.ok).toBe(false);
  });
});
