import { describe, expect, it, vi } from 'vitest';
import { errorKind, jobFailureFromError, logJobFailure } from '../src/lib/job-failure-log.js';
import { metrics } from '../src/lib/metrics.js';

// Structured failure logging: job failures must be single grep-able JSON
// lines carrying job name, taskId, and error kind — the minimum for
// log-based alerting — instead of multi-line stack dumps. The Prometheus
// counter is fed through the recorder lib/metrics.ts injects via
// setJobFailureRecorder (wired at import time on the singleton).

describe('logJobFailure', () => {
  it('emits one single-line JSON entry with job name, taskId, and error kind', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logJobFailure({
      jobName: 'run-task',
      taskId: 'task-1',
      jobId: '42',
      errorKind: 'Error',
      message: 'boom',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(typeof line).toBe('string');
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      level: 'error',
      event: 'job_failed',
      jobName: 'run-task',
      taskId: 'task-1',
      jobId: '42',
      errorKind: 'Error',
      message: 'boom',
    });
    spy.mockRestore();
  });

  it('increments the labeled failure counter so alerts need no log parsing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logJobFailure({ jobName: 'merge-gate', errorKind: 'MergeConflictError', message: 'x' });

    spy.mockRestore();
    const text = await metrics.render();
    expect(text).toContain(
      'lemniscate_job_failures_total{job_name="merge-gate",error_kind="MergeConflictError"} 1',
    );
  });

  it('skips the counter with recordMetric: false (the throw was already counted)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logJobFailure(
      { jobName: 'review-pr', errorKind: 'TimeoutError', message: 'x' },
      { recordMetric: false },
    );

    spy.mockRestore();
    const text = await metrics.render();
    expect(text).not.toContain('job_name="review-pr"');
  });
});

describe('jobFailureFromError', () => {
  it('derives kind and message from an Error', () => {
    const entry = jobFailureFromError('review-pr', new TypeError('bad diff'), { taskId: 't9' });

    expect(entry).toEqual({
      jobName: 'review-pr',
      taskId: 't9',
      errorKind: 'TypeError',
      message: 'bad diff',
    });
  });
});

describe('errorKind', () => {
  it('uses the constructor name for Errors and typeof otherwise', () => {
    expect(errorKind(new RangeError('x'))).toBe('RangeError');
    expect(errorKind('nope')).toBe('string');
    expect(errorKind(undefined)).toBe('undefined');
  });
});
