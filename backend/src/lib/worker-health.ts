import { createServer, type Server, type ServerResponse } from 'node:http';
import { getAgentTasksQueue } from './proposal-scheduler.js';

const DEFAULT_HEALTH_PORT = 3100;
const HEALTH_PATH = '/health';

export interface WorkerHealthPayload {
  ok: boolean;
  queue: string;
  counts: Record<string, number>;
  updatedAt: string;
}

export function resolveWorkerHealthPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORKER_HEALTH_PORT;
  if (!raw) return DEFAULT_HEALTH_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEALTH_PORT;
}

async function collectHealthPayload(): Promise<WorkerHealthPayload> {
  const queue = getAgentTasksQueue();
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'completed', 'failed');
  return { ok: true, queue: queue.name, counts, updatedAt: new Date().toISOString() };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleHealthRequest(res: ServerResponse): Promise<void> {
  try {
    sendJson(res, 200, await collectHealthPayload());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 503, { ok: false, error: message });
  }
}

function logHealthServerError(err: unknown, port: number): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({
    level: 'error',
    msg: 'worker health server failed; continuing without liveness endpoint',
    port,
    error: message,
  }));
}

export function startWorkerHealthServer(port: number = resolveWorkerHealthPort()): Server {
  const server = createServer((req, res) => {
    if (req.url !== HEALTH_PATH) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    void handleHealthRequest(res);
  });
  // A listen failure (e.g. EADDRINUSE) must not crash the worker: log a
  // structured line and keep consuming jobs without the liveness endpoint.
  server.on('error', (err) => logHealthServerError(err, port));
  server.listen(port);
  return server;
}
