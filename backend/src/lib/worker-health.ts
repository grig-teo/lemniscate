import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Queue } from 'bullmq';
import { probeDependency, READINESS_TIMEOUT_MS } from './health.js';
import { METRICS_CONTENT_TYPE, renderMetrics } from './metrics.js';

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
  // Prometheus exposition for the worker process (job durations/failures,
  // LLM outcomes, queue gauges). When omitted, /metrics 404s like any
  // unknown path.
  renderMetrics?: () => Promise<string>;
}

// BullMQ keys getJobCounts' result by the requested state names ('waiting',
// ...), but the underlying Redis list is 'wait' and older versions/docs
// surface that alias — fold it in here so /health and the queue gauges never
// silently read a 0 backlog. This is the single normalization point; metrics
// and health both consume this snapshot.
function normalizeCounts(counts: Record<string, number>): Record<string, number> {
  if (counts.wait === undefined) return counts;
  const { wait, ...rest } = counts;
  return { ...rest, waiting: (rest.waiting ?? 0) + wait };
}

export async function queueSnapshot(queue: Queue): Promise<WorkerQueueSnapshot> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  return {
    ok: true,
    queue: queue.name,
    counts: normalizeCounts(counts),
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

async function handleMetrics(res: ServerResponse): Promise<void> {
  try {
    res.writeHead(200, { 'content-type': METRICS_CONTENT_TYPE });
    res.end(await renderMetrics());
    return;
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Unauthenticated /metrics alongside /health and /health/ready: this port is
// only reachable on the internal compose network, and the exposition is
// aggregate-only (queue counts, durations, token totals — no per-user data).
export function startWorkerHealthServer(
  queue: Queue,
  port = 3100,
  deps: WorkerHealthDeps = {},
): Server {
  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      void handleMetrics(res);
      return;
    }
    if (req.url === '/health') {
      void handleHealth(queue, res);
      return;
    }
    if (req.url === '/health/ready') {
      void handleReady(deps, res);
      return;
    }
    if (req.url === '/metrics' && deps.renderMetrics) {
      void deps.renderMetrics().then((text) => {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(text);
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  });
  server.listen(port);
  return server;
}
