// Single home for all Prometheus metrics (one Registry, AGENTS.md §6). Fed by
// the worker (queue gauges, job durations/outcomes, failures) and by every
// process calling the LLM client; served on the worker's :3100/metrics and on
// the token-guarded API GET /metrics.
//
// Label cardinality rule: only job name, error kind, model, and queue state —
// never taskId/userId — so series counts stay bounded regardless of load.

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export const metricsRegistry = new Registry();
export const METRICS_CONTENT_TYPE = metricsRegistry.contentType;

collectDefaultMetrics({ register: metricsRegistry });

const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed', 'completed'] as const;
const DEFAULT_QUEUE_POLL_INTERVAL_MS = 15_000;

export interface QueueCountsSnapshot {
  queue: string;
  counts: Record<string, number>;
}

export interface LlmCallMetric {
  model: string;
  /** 'ok', or the LlmError kind ('http' | 'timeout' | 'network' | 'protocol'). */
  status: string;
  latencyMs: number;
  usage?: { promptTokens: number; completionTokens: number };
}

const queueJobs = new Gauge({
  name: 'lemniscate_queue_jobs',
  help: 'BullMQ job counts by queue and state',
  labelNames: ['queue', 'state'],
  registers: [metricsRegistry],
});

const jobsTotal = new Counter({
  name: 'lemniscate_jobs_total',
  help: 'BullMQ jobs processed by name and outcome',
  labelNames: ['job_name', 'outcome'],
  registers: [metricsRegistry],
});

const jobDurationSeconds = new Histogram({
  name: 'lemniscate_job_duration_seconds',
  help: 'BullMQ job processing time by job name',
  labelNames: ['job_name'],
  buckets: [5, 30, 60, 300, 600, 1800, 3600],
  registers: [metricsRegistry],
});

const jobFailuresTotal = new Counter({
  name: 'lemniscate_job_failures_total',
  help: 'Job failures by job name and error kind (mirrors the job_failed log event)',
  labelNames: ['job_name', 'error_kind'],
  registers: [metricsRegistry],
});

const llmRequestsTotal = new Counter({
  name: 'lemniscate_llm_requests_total',
  help: 'LLM chat completion calls by model and outcome status',
  labelNames: ['model', 'status'],
  registers: [metricsRegistry],
});

const llmRequestDurationSeconds = new Histogram({
  name: 'lemniscate_llm_request_duration_seconds',
  help: 'LLM chat completion latency (including retries) by model',
  labelNames: ['model'],
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [metricsRegistry],
});

const llmTokensTotal = new Counter({
  name: 'lemniscate_llm_tokens_total',
  help: 'LLM tokens consumed by model and kind (prompt/completion)',
  labelNames: ['model', 'kind'],
  registers: [metricsRegistry],
});

export function updateQueueGauges(queueName: string, counts: Record<string, number>): void {
  for (const state of QUEUE_STATES) {
    queueJobs.set({ queue: queueName, state }, counts[state] ?? 0);
  }
}

// One poll tick: copy a queue snapshot into the gauges. A failed read (Redis
// blip) keeps the last known values instead of blanking the dashboard.
export async function pollQueueMetrics(
  snapshot: () => Promise<QueueCountsSnapshot>,
): Promise<void> {
  try {
    const { queue, counts } = await snapshot();
    updateQueueGauges(queue, counts);
  } catch {
    // Last known values stand; the health endpoint reports the outage itself.
  }
}

// Scrapes are cheap but getJobCounts hits Redis; polling decouples the scrape
// rate from Redis load. Same data source as worker-health's /health payload.
export function startQueueMetricsPoller(
  snapshot: () => Promise<QueueCountsSnapshot>,
  intervalMs = DEFAULT_QUEUE_POLL_INTERVAL_MS,
): () => void {
  void pollQueueMetrics(snapshot);
  const timer = setInterval(() => void pollQueueMetrics(snapshot), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function observeJobOutcome(jobName: string, outcome: 'completed' | 'failed', seconds: number): void {
  jobDurationSeconds.observe({ job_name: jobName }, seconds);
  jobsTotal.inc({ job_name: jobName, outcome });
}

// Wrap a BullMQ processor: records duration + outcome, rethrows failures so
// BullMQ retry semantics are untouched. `jobName` must be pre-sanitized by
// the caller (known names only) to keep cardinality bounded.
export async function measureJob<T>(jobName: string, run: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await run();
    observeJobOutcome(jobName, 'completed', (performance.now() - startedAt) / 1000);
    return result;
  } catch (err) {
    observeJobOutcome(jobName, 'failed', (performance.now() - startedAt) / 1000);
    throw err;
  }
}

export function recordJobFailureMetric(entry: { jobName: string; errorKind: string }): void {
  jobFailuresTotal.inc({ job_name: entry.jobName, error_kind: entry.errorKind });
}

export function recordLlmCall(metric: LlmCallMetric): void {
  llmRequestsTotal.inc({ model: metric.model, status: metric.status });
  llmRequestDurationSeconds.observe({ model: metric.model }, metric.latencyMs / 1000);
  if (!metric.usage) return;
  llmTokensTotal.inc({ model: metric.model, kind: 'prompt' }, metric.usage.promptTokens);
  llmTokensTotal.inc({ model: metric.model, kind: 'completion' }, metric.usage.completionTokens);
}

export async function renderMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}
