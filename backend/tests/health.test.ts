import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { checkReadiness } from '../src/lib/health.js';
import { registerHealthRoutes, type HealthDeps } from '../src/routes/health.js';

// Readiness contract: /health stays a dependency-free liveness probe while
// /health/ready verifies Postgres (SELECT 1), Redis (PING) and — when MinIO
// is configured — the library bucket (ensured via bucketExists/makeBucket),
// answering 503 with per-check results when any dependency is down or too
// slow to answer.
// minio is tri-state in the payload: null means "not configured" and does
// not affect readiness.

const healthyDeps: HealthDeps = {
  checkPostgres: async () => 1,
  checkRedis: async () => 'PONG',
};

async function buildApp(deps: HealthDeps) {
  const app = Fastify({ logger: false });
  registerHealthRoutes(app, deps);
  return app;
}

describe('GET /health (liveness)', () => {
  it('answers ok without touching any dependency', async () => {
    let touched = false;
    const app = await buildApp({
      checkPostgres: async () => {
        touched = true;
        throw new Error('db down');
      },
      checkRedis: async () => {
        touched = true;
        throw new Error('redis down');
      },
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(touched).toBe(false);
  });
});

describe('GET /health/ready (readiness)', () => {
  it('returns 200 with per-check results when all dependencies answer', async () => {
    const app = await buildApp(healthyDeps);
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, postgres: true, redis: true, minio: null });
  });

  it('returns 503 when the Postgres check throws', async () => {
    const app = await buildApp({
      ...healthyDeps,
      checkPostgres: async () => {
        throw new Error('connection refused');
      },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, postgres: false, redis: true, minio: null });
  });

  it('returns 503 when the Redis check throws', async () => {
    const app = await buildApp({
      ...healthyDeps,
      checkRedis: async () => {
        throw new Error('READONLY');
      },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, postgres: true, redis: false, minio: null });
  });

  it('reports minio: true when the configured bucket exists', async () => {
    const app = await buildApp({ ...healthyDeps, checkMinio: async () => true });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, postgres: true, redis: true, minio: true });
  });

  it('returns 503 when the MinIO check throws', async () => {
    const app = await buildApp({
      ...healthyDeps,
      checkMinio: async () => {
        throw new Error('bucket missing');
      },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, postgres: true, redis: true, minio: false });
  });
});

describe('checkReadiness', () => {
  it('fails a check that hangs past the timeout instead of waiting forever', async () => {
    const hanging = () => new Promise(() => {});
    const report = await checkReadiness(
      { checkPostgres: hanging, checkRedis: healthyDeps.checkRedis },
      50,
    );
    expect(report).toEqual({ postgres: false, redis: true, minio: null });
  });

  it('runs both checks even when one rejects synchronously', async () => {
    let redisChecked = false;
    const report = await checkReadiness({
      checkPostgres: () => Promise.reject(new Error('down')),
      checkRedis: async () => {
        redisChecked = true;
      },
    });
    expect(redisChecked).toBe(true);
    expect(report).toEqual({ postgres: false, redis: true, minio: null });
  });

  it('reports minio: null when no MinIO check is configured', async () => {
    const report = await checkReadiness(healthyDeps);
    expect(report.minio).toBeNull();
  });

  it('fails a hanging MinIO check past the timeout', async () => {
    const report = await checkReadiness(
      { ...healthyDeps, checkMinio: () => new Promise(() => {}) },
      50,
    );
    expect(report).toEqual({ postgres: true, redis: true, minio: false });
  });
});
