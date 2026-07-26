// Single home for all Prometheus instrumentation (AGENTS.md §6): the
// registry, every instrument, the /metrics route, the Fastify hook, the
// worker job wrapper and the queue-count poller. No module outside this
// file creates prom-client metrics.
//
// Cardinality rules (bounded labels only):
// - HTTP: method + route TEMPLATE (request.routeOptions.url) + status code.
//   Raw URLs would leak IDs/query strings into labels — unmatched routes
//   collapse to the constant 'unmatched'.
// - Jobs: BullMQ job NAME (a fixed set in worker.ts), never job/task IDs.
// - LLM: outcome only ('success' | LlmError.kind), never model/endpoint.

import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from './logger.js';
import { errorKind, setJobFailureRecorder } from './job-failure-log.js';
import { setLlmObserver, type LlmOutcome } from './llm-client.js';

const PREFIX = 'lemniscate_';
const UNMATCHED_ROUTE = 'unmatched';

declare module 'fastify' {
  interface FastifyRequest {
    metricsStartTime?: bigint;
  }
}

export interface QueueCountsSource {
  name: string;
  getCounts: () => Promise<Record<string, number>>;
}

export interface Metrics {
  render: () => Promise<string>;
  contentType: string;
  recordHttpRequest: (
    labels: { method: string; route: string; statusCode: number },
    durationSeconds: number,
  ) => void;
  observeJob: <T>(jobName: string, fn: () => Promise<T>) => Promise<T>;
  recordJobFailure: (jobName: string, errorKind: string) => void;
  recordLlmRequest: (outcome: LlmOutcome, durationSeconds: number) => void;
  setQueueJobCount: (queue: string, state: string, count: number) => void;
}

const HTTP_LABELS = ['method', 'route', 'status_code'] as const;

// All instruments for one registry, grouped by concern so no function
// exceeds the AGENTS.md line limits.
interface Instruments {
  httpRequests: Counter<string>;
  httpDuration: Histogram<string>;
  jobDuration: Histogram<string>;
  jobFailures: Counter<string>;
  llmRequests: Counter<string>;
  llmDuration: Histogram<string>;
  queueJobs: Gauge<string>;
}

function createHttpInstruments(registry: Registry): Pick<Instruments, 'httpRequests' | 'httpDuration'> {
  const httpRequests = new Counter({
    name: `${PREFIX}http_requests_total`,
    help: 'HTTP requests by method, route template and status code',
    labelNames: [...HTTP_LABELS],
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: `${PREFIX}http_request_duration_seconds`,
    help: 'HTTP request duration by method, route template and status code',
    labelNames: [...HTTP_LABELS],
    registers: [registry],
  });
  return { httpRequests, httpDuration };
}

function createJobInstruments(registry: Registry): Pick<Instruments, 'jobDuration' | 'jobFailures' | 'queueJobs'> {
  const jobDuration = new Histogram({
    name: `${PREFIX}job_duration_seconds`,
    help: 'BullMQ job run duration by job name',
    labelNames: ['job_name'],
    buckets: [1, 5, 30, 60, 300, 900, 1800, 3600],
    registers: [registry],
  });
  const jobFailures = new Counter({
    name: `${PREFIX}job_failures_total`,
    help: 'BullMQ job failures by job name and error kind',
    labelNames: ['job_name', 'error_kind'],
    registers: [registry],
  });
  const queueJobs = new Gauge({
    name: `${PREFIX}queue_jobs`,
    help: 'BullMQ job counts by queue and state',
    labelNames: ['queue', 'state'],
    registers: [registry],
  });
  return { jobDuration, jobFailures, queueJobs };
}

function createLlmInstruments(registry: Registry): Pick<Instruments, 'llmRequests' | 'llmDuration'> {
  const llmRequests = new Counter({
    name: `${PREFIX}llm_requests_total`,
    help: 'LLM chat-completions requests by outcome',
    labelNames: ['outcome'],
    registers: [registry],
  });
  const llmDuration = new Histogram({
    name: `${PREFIX}llm_request_duration_seconds`,
    help: 'LLM chat-completions request duration by outcome',
    labelNames: ['outcome'],
    buckets: [0.5, 2, 5, 15, 30, 60, 120, 300, 600],
    registers: [registry],
  });
  return { llmRequests, llmDuration };
}

function createInstruments(registry: Registry): Instruments {
  return {
    ...createHttpInstruments(registry),
    ...createJobInstruments(registry),
    ...createLlmInstruments(registry),
  };
}

async function observeJobRun<T>(i: Instruments, jobName: string, fn: () => Promise<T>): Promise<T> {
  const stop = i.jobDuration.startTimer({ job_name: jobName });
  try {
    return await fn();
  } catch (err) {
    i.jobFailures.inc({ job_name: jobName, error_kind: errorKind(err) });
    throw err;
  } finally {
    stop();
  }
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  const i = createInstruments(registry);
  return {
    render: () => registry.metrics(),
    contentType: registry.contentType,
    recordHttpRequest: ({ method, route, statusCode }, durationSeconds) => {
      const labels = { method, route, status_code: String(statusCode) };
      i.httpRequests.inc(labels);
      i.httpDuration.observe(labels, durationSeconds);
    },
    observeJob: (jobName, fn) => observeJobRun(i, jobName, fn),
    recordJobFailure: (jobName, errorKind) => {
      i.jobFailures.inc({ job_name: jobName, error_kind: errorKind });
    },
    recordLlmRequest: (outcome, durationSeconds) => {
      i.llmRequests.inc({ outcome });
      i.llmDuration.observe({ outcome }, durationSeconds);
    },
    setQueueJobCount: (queue, state, count) => {
      i.queueJobs.set({ queue, state }, count);
    },
  };
}

// Process-wide singleton used by the API and worker entrypoints. Tests build
// isolated instances with createMetrics().
export const metrics = createMetrics();

// Feed LLM outcomes into the singleton as soon as anything imports this
// module; llm-client itself stays free of prom-client so it remains usable
// in config-free/test contexts.
setLlmObserver((obs) => metrics.recordLlmRequest(obs.outcome, obs.latencyMs / 1000));

// Same pattern for structured job-failure logs: in-run failures are caught
// and recorded on the task (the BullMQ job then completes), so observeJob
// never sees them — logJobFailure is the single funnel that counts them.
setJobFailureRecorder((jobName, kind) => metrics.recordJobFailure(jobName, kind));

// Route template for labels; 'unmatched' for 404s so raw URLs (and their
// unbounded IDs) never become label values.
function routeLabel(request: FastifyRequest): string {
  return request.routeOptions.url ?? UNMATCHED_ROUTE;
}

export function registerHttpMetricsHook(app: FastifyInstance, m: Metrics): void {
  app.addHook('onRequest', async (request) => {
    request.metricsStartTime = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (request, reply) => {
    const start = request.metricsStartTime;
    const durationSeconds = start === undefined ? 0 : Number(process.hrtime.bigint() - start) / 1e9;
    m.recordHttpRequest(
      { method: request.method, route: routeLabel(request), statusCode: reply.statusCode },
      durationSeconds,
    );
  });
}

function metricsAuthorized(request: FastifyRequest, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function sendMetrics(reply: FastifyReply, m: Metrics): Promise<string> {
  reply.header('content-type', m.contentType);
  return m.render();
}

// /metrics leaks internal state (queue sizes, route names), so it requires a
// bearer token and returns 404 (indistinguishable from "no such route") when
// METRICS_TOKEN is unset — the frontend nginx then has nothing to proxy.
export function registerMetricsRoute(app: FastifyInstance, m: Metrics, token?: string): void {
  app.get('/metrics', async (request, reply) => {
    if (!token) return reply.code(404).send({ error: 'not found' });
    if (!metricsAuthorized(request, token)) return reply.code(401).send({ error: 'unauthorized' });
    return sendMetrics(reply, m);
  });
}

export async function pollQueueCounts(m: Metrics, sources: QueueCountsSource[]): Promise<void> {
  for (const source of sources) {
    try {
      const counts = await source.getCounts();
      for (const [state, count] of Object.entries(counts)) {
        m.setQueueJobCount(source.name, state, count);
      }
    } catch (err) {
      logger.error({ source: source.name, errorKind: errorKind(err) }, 'queue metrics poll failed');
    }
  }
}

// Refreshes queue gauges on an interval (worker: 15s). Returns a stop
// function for graceful shutdown.
export function startQueueMetricsPoller(
  m: Metrics,
  sources: QueueCountsSource[],
  intervalMs: number,
): () => void {
  const timer = setInterval(() => {
    void pollQueueCounts(m, sources);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
