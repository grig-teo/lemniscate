// Single structured failure log for BullMQ jobs. Both the worker's 'failed'
// hook and recordJobFailure (in-run task failures, agent-git.ts) emit through
// here, so log-based alerting can match one single-line JSON shape —
// job name + taskId + error kind — instead of multi-line stack dumps.
// Every entry also increments the lemniscate_job_failures_total Prometheus
// counter (same job name + error kind labels), so alerts can be expressed
// from scraped metrics alone, without log parsing.

import { recordJobFailureMetric } from './metrics.js';

export interface JobFailureEntry {
  jobName: string;
  errorKind: string;
  message: string;
  taskId?: string;
  jobId?: string;
}

export function errorKind(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

export function jobFailureFromError(
  jobName: string,
  err: unknown,
  ids: { taskId?: string; jobId?: string } = {},
): JobFailureEntry {
  const message = err instanceof Error ? err.message : String(err);
  return { jobName, errorKind: errorKind(err), message, ...ids };
}

export function logJobFailure(entry: JobFailureEntry): void {
  recordJobFailureMetric(entry);
  console.error(JSON.stringify({ level: 'error', event: 'job_failed', ...entry }));
}
