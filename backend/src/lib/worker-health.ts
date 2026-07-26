import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Queue } from 'bullmq';

export interface WorkerQueueSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  ts: string;
}

export async function queueSnapshot(queue: Queue): Promise<WorkerQueueSnapshot> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
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
    sendJson(res, 200, { ok: true, ...snapshot });
    return;
  } catch (err) {
    sendJson(res, 503, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    });
  }
}

export function startWorkerHealthServer(queue: Queue, port = 3100): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url !== '/health') {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    void handleHealth(queue, res);
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}
