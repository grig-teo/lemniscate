import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMetrics,
  pollQueueCounts,
  registerHttpMetricsHook,
  registerMetricsRoute,
  startQueueMetricsPoller,
  type Metrics,
  type QueueCountsSource,
} from '../src/lib/metrics.js';

// Prometheus exposition contract: the /metrics endpoint is token-guarded
// (404 when unconfigured so it is never publicly routable), HTTP labels use
// route templates (never raw URLs, which would explode cardinality), job
// wrappers time runs and count failures by job name, and queue gauges come
// from BullMQ job counts.

const TOKEN = 'metrics-test-token';

function buildApp(metrics: Metrics, token?: string): FastifyInstance {
  const app = Fastify({ logger: false });
  registerHttpMetricsHook(app, metrics);
  app.get('/things/:id', async () => ({ ok: true }));
  registerMetricsRoute(app, metrics, token);
  return app;
}

function authed(app: FastifyInstance, token = TOKEN) {
  return app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /metrics guard', () => {
  it('returns 404 when no metrics token is configured', async () => {
    const app = buildApp(createMetrics());
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(404);
  });

  it('returns 401 without a bearer token and with a wrong one', async () => {
    const app = buildApp(createMetrics(), TOKEN);
    const missing = await app.inject({ method: 'GET', url: '/metrics' });
    expect(missing.statusCode).toBe(401);
    const wrong = await authed(app, 'not-the-token');
    expect(wrong.statusCode).toBe(401);
  });

  it('serves the registry as prometheus text with the right token', async () => {
    const app = buildApp(createMetrics(), TOKEN);
    const response = await authed(app);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('lemniscate_http_requests_total');
  });
});

describe('HTTP request instrumentation', () => {
  it('counts requests by method, route template and status — never raw URLs', async () => {
    const metrics = createMetrics();
    const app = buildApp(metrics, TOKEN);
    await app.inject({ method: 'GET', url: '/things/abc123?secret=1' });
    const { body } = await authed(app);
    expect(body).toContain(
      'lemniscate_http_requests_total{method="GET",route="/things/:id",status_code="200"} 1',
    );
    expect(body).not.toContain('/things/abc123');
    expect(body).not.toContain('secret=1');
  });

  it('observes request durations in the histogram', async () => {
    const metrics = createMetrics();
    const app = buildApp(metrics, TOKEN);
    await app.inject({ method: 'GET', url: '/things/abc' });
    const { body } = await authed(app);
    expect(body).toContain(
      'lemniscate_http_request_duration_seconds_count{method="GET",route="/things/:id",status_code="200"} 1',
    );
  });

  it('labels unmatched routes as "unmatched" instead of the raw URL', async () => {
    const metrics = createMetrics();
    const app = buildApp(metrics, TOKEN);
    await app.inject({ method: 'GET', url: '/no/such/route/12345' });
    const { body } = await authed(app);
    expect(body).toContain('route="unmatched"');
    expect(body).not.toContain('/no/such/route/12345');
  });
});

describe('observeJob', () => {
  it('records the run duration for a successful job', async () => {
    const metrics = createMetrics();
    const result = await metrics.observeJob('run-task', async () => 'done');
    expect(result).toBe('done');
    const body = await metrics.render();
    expect(body).toContain(
      'lemniscate_job_duration_seconds_count{job_name="run-task"} 1',
    );
  });

  it('increments the failure counter with job name and error kind, then rethrows', async () => {
    const metrics = createMetrics();
    await expect(
      metrics.observeJob('merge-gate', async () => {
        throw new TypeError('boom');
      }),
    ).rejects.toThrow('boom');
    const body = await metrics.render();
    expect(body).toContain(
      'lemniscate_job_failures_total{job_name="merge-gate",error_kind="TypeError"} 1',
    );
    expect(body).toContain(
      'lemniscate_job_duration_seconds_count{job_name="merge-gate"} 1',
    );
  });
});

describe('recordLlmRequest', () => {
  it('counts requests and durations by outcome', async () => {
    const metrics = createMetrics();
    metrics.recordLlmRequest('success', 1.5);
    metrics.recordLlmRequest('success', 0.5);
    metrics.recordLlmRequest('timeout', 30);
    const body = await metrics.render();
    expect(body).toContain('lemniscate_llm_requests_total{outcome="success"} 2');
    expect(body).toContain('lemniscate_llm_requests_total{outcome="timeout"} 1');
    expect(body).toContain(
      'lemniscate_llm_request_duration_seconds_count{outcome="success"} 2',
    );
  });
});

describe('queue gauges', () => {
  const source: QueueCountsSource = {
    name: 'agent-tasks',
    getCounts: async () => ({ waiting: 3, active: 1, delayed: 0, failed: 2, completed: 9 }),
  };

  it('sets one gauge per queue state from BullMQ job counts', async () => {
    const metrics = createMetrics();
    await pollQueueCounts(metrics, [source]);
    const body = await metrics.render();
    expect(body).toContain('lemniscate_queue_jobs{queue="agent-tasks",state="waiting"} 3');
    expect(body).toContain('lemniscate_queue_jobs{queue="agent-tasks",state="failed"} 2');
    expect(body).toContain('lemniscate_queue_jobs{queue="agent-tasks",state="completed"} 9');
  });

  it('poller refreshes on an interval and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const metrics = createMetrics();
      const getCounts = vi.fn().mockResolvedValue({ waiting: 1 });
      const stop = startQueueMetricsPoller(metrics, [{ name: 'q', getCounts }], 1000);
      await vi.advanceTimersByTimeAsync(2500);
      expect(getCounts.mock.calls.length).toBeGreaterThanOrEqual(2);
      stop();
      const callsAtStop = getCounts.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(getCounts.mock.calls.length).toBe(callsAtStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a source that rejects', async () => {
    const metrics = createMetrics();
    await expect(
      pollQueueCounts(metrics, [
        { name: 'q', getCounts: async () => Promise.reject(new Error('redis down')) },
      ]),
    ).resolves.toBeUndefined();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
