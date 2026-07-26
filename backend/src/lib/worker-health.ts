import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Queue } from 'bullmq';
import { probeDependency, READINESS_TIMEOUT_MS } from './health.js';

export interface WorkerQueueSnapshot {
  ok: true;
  queue: string;
  counts: Record<string, number>;
  ts: string;
}

// Readiness inputs for /health/ready. Both are optional so the server stays
// testable without Redis; a missing check reports null and stays neutral.
export interface WorkerHealthDeps {
  // Bounded PING against the queue's Redis (see lib/redis.ts).
  checkRedis?: () => Promise<unknown>;
  // BullMQ worker.isRunning() — false when the consumer stopped.
  isRunning?: () => boolean;
}

export async function queueSnapshot(queue: Queue): Promise<WorkerQueueSnapshot> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  return {
    ok: true,
    queue: queue.name,
    counts,
    ts: new Date().toISOString(),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleHealth(queue: Queue, res: ServerResponse): Promise<void> {
  try {
    const snapshot = await queueSnapshot(queue);
    sendJson(res, 200, snapshot);
    return;
  } catch (err) {
    sendJson(res, 503, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    });
  }
}

// Readiness, not liveness: 503s when the queue's Redis is unreachable (a
// stalled pipeline) or the BullMQ consumer stopped, so compose restarts the
// worker instead of leaving tasks stuck in 'running'.
async function handleReady(deps: WorkerHealthDeps, res: ServerResponse): Promise<void> {
  const redis = deps.checkRedis
    ? await probeDependency(deps.checkRedis, READINESS_TIMEOUT_MS)
    : null;
  const running = deps.isRunning ? deps.isRunning() : null;
  const ok = redis !== false && running !== false;
  sendJson(res, ok ? 200 : 503, { ok, redis, worker: running, ts: new Date().toISOString() });
}

export function startWorkerHealthServer(
  queue: Queue,
  port = 3100,
  deps: WorkerHealthDeps = {},
): Server {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      void handleHealth(queue, res);
      return;
    }
    if (req.url === '/health/ready') {
      void handleReady(deps, res);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  });
  server.listen(port);
  return server;
}
