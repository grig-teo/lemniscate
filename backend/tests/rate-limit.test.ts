import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it } from 'vitest';

// Smoke test for the rate-limit contract used in main.ts: a global bucket
// (~300/min) with stricter per-route buckets via `config.rateLimit` — the
// tight bucket 429s while the global one stays out of the way.

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.get(
    '/tight',
    { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } },
    async () => ({ ok: true }),
  );
  app.get('/loose', async () => ({ ok: true }));
  return app;
}

describe('rate limiting', () => {
  it('429s requests beyond the stricter per-route bucket', async () => {
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url: '/tight' });
    const second = await app.inject({ method: 'GET', url: '/tight' });
    const third = await app.inject({ method: 'GET', url: '/tight' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toBe('Too Many Requests');
  });

  it('leaves other routes governed by the global bucket', async () => {
    const app = await buildApp();
    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/loose' });
      expect(response.statusCode).toBe(200);
    }
  });
});
