import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

// Wiring test: the real app (buildApp) must expose the token-guarded
// /metrics endpoint and feed the HTTP histogram through the onResponse
// hook. METRICS_TOKEN comes from vitest.config.ts test env. No external
// service is contacted: route registration is lazy and /health's
// dependencies are only probed on request.

describe('buildApp /metrics wiring', () => {
  it('rejects unauthenticated scrapes and serves the registry with the bearer token', async () => {
    const app = await buildApp();
    const rejected = await app.inject({ method: 'GET', url: '/metrics' });
    expect(rejected.statusCode).toBe(401);

    await app.inject({ method: 'GET', url: '/health' });
    const scraped = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer test-metrics-token' },
    });
    expect(scraped.statusCode).toBe(200);
    expect(scraped.body).toContain(
      'lemniscate_http_requests_total{method="GET",route="/health",status_code="200"} 1',
    );
    await app.close();
  });
});
