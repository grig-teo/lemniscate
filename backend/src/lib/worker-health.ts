import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Queue } from 'bullmq';
import { errorMessage } from './utils.js';

// Minimal liveness endpoint for the BullMQ worker process, which otherwise
// has no HTTP surface an orchestrator can probe. Returns the queue's job
// counts so operators can see work piling up (waiting) or failing; 503 when
// Redis is unreadable, which flips the compose healthcheck to unhealthy.

export interface QueueSnapshot {
  ok: boolean;
  queue: string;
  counts: Record<string, number>;
  ts: string;
}

export async function queueSnapshot(queue: Queue): Promise<QueueSnapshot> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  return { ok: true, queue: queue.name, counts, ts: new Date().toISOString() };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleHealth(res: ServerResponse, queue: Queue): Promise<void> {
  try {
    sendJson(res, 200, await queueSnapshot(queue));
  } catch (err) {
    sendJson(res, 503, { ok: false, error: errorMessage(err) });
  }
}

export function startWorkerHealthServer(queue: Queue, port: number): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/health') {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    void handleHealth(res, queue);
  });
  server.listen(port);
  return server;
}
