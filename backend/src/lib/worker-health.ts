import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Queue } from 'bullmq';
import { METRICS_CONTENT_TYPE, renderMetrics } from './metrics.js';

export interface WorkerQueueSnapshot {
  ok: true;
  queue: string;
  counts: Record<string, number>;
  ts: string;
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

// Unauthenticated /metrics alongside /health: this port is only reachable on
// the internal compose network, and the exposition is aggregate-only (queue
// counts, durations, token totals — no per-user data).
export function startWorkerHealthServer(queue: Queue, port = 3100): Server {
  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      void handleMetrics(res);
      return;
    }
    if (req.url !== '/health') {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    void handleHealth(queue, res);
  });
  server.listen(port);
  return server;
}
