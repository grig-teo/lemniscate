import type { Server } from 'node:http';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { queueSnapshot, startWorkerHealthServer, type WorkerHealthDeps } from '../src/lib/worker-health.js';

// Worker liveness: a tiny HTTP endpoint exposing BullMQ job counts so
// compose/orchestrators can probe the otherwise headless worker process and
// see work pile up (waiting) or fail. The queue is faked — no Redis needed.

function fakeQueue(result: Record<string, number> | Error): Queue {
  const getJobCounts =
    result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  return { name: 'agent-tasks', getJobCounts } as unknown as Queue;
}

async function fetchJson(
  server: Server,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
}

function listenOnRandomPort(queue: Queue): Promise<Server> {
  const server = startWorkerHealthServer(queue, 0);
  return new Promise((resolve) => server.on('listening', () => resolve(server)));
}

describe('queueSnapshot', () => {
  it('returns the queue name and job counts', async () => {
    const counts = { waiting: 3, active: 1, failed: 2 };
    const snapshot = await queueSnapshot(fakeQueue(counts));

    expect(snapshot.ok).toBe(true);
    expect(snapshot.queue).toBe('agent-tasks');
    expect(snapshot.counts).toEqual(counts);
    expect(typeof snapshot.ts).toBe('string');
  });
});

describe('startWorkerHealthServer', () => {
  it('answers 200 with job counts on /health', async () => {
    const server = await listenOnRandomPort(fakeQueue({ waiting: 5, active: 2 }));
    try {
      const { status, body } = await fetchJson(server, '/health');
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.counts).toEqual({ waiting: 5, active: 2 });
    } finally {
      server.close();
    }
  });

  it('answers 503 when the queue cannot be read (redis down)', async () => {
    const server = await listenOnRandomPort(fakeQueue(new Error('Connection is closed')));
    try {
      const { status, body } = await fetchJson(server, '/health');
      expect(status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.error).toBe('Connection is closed');
    } finally {
      server.close();
    }
  });

  it('answers 404 for any other path', async () => {
    const server = await listenOnRandomPort(fakeQueue({}));
    try {
      const { status } = await fetchJson(server, '/nope');
      expect(status).toBe(404);
    } finally {
      server.close();
    }
  });
});

// /health/ready is the worker's readiness probe: it proves the queue's Redis
// is reachable (bounded PING) and the BullMQ consumer is running, so a queue
// stall flips the container to unhealthy within one healthcheck interval.
describe('startWorkerHealthServer /health/ready', () => {
  const readyDeps = {
    checkRedis: async () => 'PONG',
    isRunning: () => true,
  };

  function listenWithDeps(deps: WorkerHealthDeps): Promise<Server> {
    const server = startWorkerHealthServer(fakeQueue({}), 0, deps);
    return new Promise((resolve) => server.on('listening', () => resolve(server)));
  }

  it('answers 200 when Redis answers and the consumer is running', async () => {
    const server = await listenWithDeps(readyDeps);
    try {
      const { status, body } = await fetchJson(server, '/health/ready');
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, redis: true, worker: true });
    } finally {
      server.close();
    }
  });

  it('answers 503 when the Redis ping rejects (queue stall)', async () => {
    const server = await listenWithDeps({
      ...readyDeps,
      checkRedis: async () => {
        throw new Error('Connection is closed');
      },
    });
    try {
      const { status, body } = await fetchJson(server, '/health/ready');
      expect(status).toBe(503);
      expect(body).toMatchObject({ ok: false, redis: false, worker: true });
    } finally {
      server.close();
    }
  });

  it('answers 503 when the consumer is not running', async () => {
    const server = await listenWithDeps({ ...readyDeps, isRunning: () => false });
    try {
      const { status, body } = await fetchJson(server, '/health/ready');
      expect(status).toBe(503);
      expect(body).toMatchObject({ ok: false, redis: true, worker: false });
    } finally {
      server.close();
    }
  });

  it('answers 503 when the Redis ping hangs past the probe timeout', async () => {
    const server = await listenWithDeps({
      ...readyDeps,
      checkRedis: () => new Promise(() => {}),
    });
    try {
      const { status, body } = await fetchJson(server, '/health/ready');
      expect(status).toBe(503);
      expect(body).toMatchObject({ ok: false, redis: false });
    } finally {
      server.close();
    }
  });

  it('reports nulls for checks no dependency was supplied for', async () => {
    const server = await listenWithDeps({});
    try {
      const { status, body } = await fetchJson(server, '/health/ready');
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, redis: null, worker: null });
    } finally {
      server.close();
    }
  });
});

describe('/metrics on the worker health server', () => {
  it('serves the Prometheus exposition when a renderer is provided', async () => {
    const server = startWorkerHealthServer(fakeQueue({ waiting: 1 }), 0, {
      renderMetrics: async () => 'lemniscate_job_failures_total 3\n',
    });
    await new Promise((resolve) => server.on('listening', resolve));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toContain('lemniscate_job_failures_total 3');
    } finally {
      server.close();
    }
  });

  it('omits /metrics when no renderer is provided', async () => {
    const server = await listenOnRandomPort(fakeQueue({ waiting: 1 }));
    try {
      const { status } = await fetchJson(server, '/metrics');
      expect(status).toBe(404);
    } finally {
      server.close();
    }
  });
});
