import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerMetricsRoutes } from '../src/routes/metrics.js';

// API-side /metrics: Prometheus cannot send arbitrary headers, so the guard
// accepts either the Traefik-style x-metrics-token shared secret or a Bearer
// token (Prometheus scrape_config `authorization`). No session cookie, and
// the payload carries only aggregate, label-bounded numbers — no per-user
// data. Empty configured token = endpoint disabled (503), same convention
// as the Traefik provider endpoint.

async function buildApp(token: string) {
  const app = Fastify({ logger: false });
  registerMetricsRoutes(app, token);
  return app;
}

describe('GET /metrics (API)', () => {
  it('answers 503 when no metrics token is configured', async () => {
    const app = await buildApp('');
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'metrics endpoint is not configured' });
  });

  it('answers 401 without the shared-secret header', async () => {
    const app = await buildApp('secret-token');
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(401);
  });

  it('answers 401 for the wrong token', async () => {
    const app = await buildApp('secret-token');
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-metrics-token': 'wrong' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('serves the Prometheus exposition with x-metrics-token', async () => {
    const app = await buildApp('secret-token');
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-metrics-token': 'secret-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('# HELP');
  });

  it('accepts a Bearer token so Prometheus authorization config works', async () => {
    const app = await buildApp('secret-token');
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(response.statusCode).toBe(200);
  });
});
