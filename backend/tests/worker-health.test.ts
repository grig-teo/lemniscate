import type { Server } from 'node:http';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { queueSnapshot, startWorkerHealthServer } from '../src/lib/worker-health.js';

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

  it("folds BullMQ's 'wait' alias into the documented 'waiting' state", async () => {
    // The gauges read counts['waiting']; if getJobCounts ever returns the
    // raw Redis list name ('wait'), the backlog signal must not read 0.
    const snapshot = await queueSnapshot(fakeQueue({ wait: 5, active: 1 }));

    expect(snapshot.counts.waiting).toBe(5);
    expect(snapshot.counts.wait).toBeUndefined();
    expect(snapshot.counts.active).toBe(1);
  });

  it('sums both keys when a snapshot carries wait alongside waiting', async () => {
    const snapshot = await queueSnapshot(fakeQueue({ wait: 2, waiting: 3 }));

    expect(snapshot.counts.waiting).toBe(5);
    expect(snapshot.counts.wait).toBeUndefined();
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

  it('serves the Prometheus exposition on /metrics', async () => {
    const server = await listenOnRandomPort(fakeQueue({}));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toContain('# HELP');
    } finally {
      server.close();
    }
  });
});
