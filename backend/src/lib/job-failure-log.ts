// Single structured failure log for BullMQ jobs. Both the worker's 'failed'
// hook and recordJobFailure (in-run task failures, agent-git.ts) emit through
// here, so log-based alerting can match one single-line JSON shape —
// job name + taskId + error kind — instead of multi-line stack dumps.
// Every entry also increments the lemniscate_job_failures_total Prometheus
// counter (same job name + error kind labels), so alerts can be expressed
// from scraped metrics alone, without log parsing.
//
// This module stays free of prom-client: lib/metrics.ts injects the counter
// via setJobFailureRecorder at import time, so job-failure-log remains
// usable in config-free/test contexts and no import cycle exists.

export interface JobFailureEntry {
  jobName: string;
  errorKind: string;
  message: string;
  taskId?: string;
  jobId?: string;
}

export interface LogJobFailureOptions {
  // Default true. The worker's 'failed' hook passes false: observeJob
  // already counted that throw, so counting again would double-report.
  recordMetric?: boolean;
}

type JobFailureRecorder = (jobName: string, errorKind: string) => void;

let recorder: JobFailureRecorder | undefined;

// Single injection point (AGENTS.md §6): lib/metrics.ts registers its
// counter here; tests can substitute their own.
export function setJobFailureRecorder(fn: JobFailureRecorder): void {
  recorder = fn;
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

export function logJobFailure(
  entry: JobFailureEntry,
  options: LogJobFailureOptions = {},
): void {
  if (options.recordMetric !== false) recorder?.(entry.jobName, entry.errorKind);
  console.error(JSON.stringify({ level: 'error', event: 'job_failed', ...entry }));
}
