import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  notifyJobFailure: vi.fn().mockResolvedValue(undefined),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/lib/notifications.js', () => ({
  notifyJobFailure: mocks.notifyJobFailure,
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: mocks.logger,
  createLogger: vi.fn(() => mocks.logger),
}));

import { errorKind, jobFailureFromError, logJobFailure } from '../src/lib/job-failure-log.js';
import { metrics } from '../src/lib/metrics.js';

// Structured failure logging: job failures must be emitted as structured
// objects via the shared Pino logger (logger.error), carrying job name,
// taskId, and error kind — the minimum for log-based alerting — instead of
// multi-line stack dumps. The Prometheus counter is fed through the recorder
// lib/metrics.ts injects via setJobFailureRecorder (wired at import time on
// the singleton). Every entry is also fanned out to the user-notification
// hook; the returned promise lets in-run callers (recordJobFailure)
// serialize the notification ahead of a rethrow so the worker 'failed' hook
// cannot race the dedupe.

describe('logJobFailure', () => {
  beforeEach(() => {
    mocks.logger.error.mockClear();
    mocks.notifyJobFailure.mockReset().mockResolvedValue(undefined);
  });

  it('emits one structured entry with job name, taskId, and error kind', () => {
    logJobFailure({
      jobName: 'run-task',
      taskId: 'task-1',
      jobId: '42',
      errorKind: 'Error',
      message: 'boom',
    });

    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error).toHaveBeenCalledWith({
      event: 'job_failed',
      jobName: 'run-task',
      taskId: 'task-1',
      jobId: '42',
      errorKind: 'Error',
      message: 'boom',
    });
  });

  it('increments the labeled failure counter so alerts need no log parsing', async () => {
    logJobFailure({ jobName: 'merge-gate', errorKind: 'MergeConflictError', message: 'x' });

    const text = await metrics.render();
    expect(text).toContain(
      'lemniscate_job_failures_total{job_name="merge-gate",error_kind="MergeConflictError"} 1',
    );
  });

  it('skips the counter with recordMetric: false (the throw was already counted)', async () => {
    logJobFailure(
      { jobName: 'review-pr', errorKind: 'TimeoutError', message: 'x' },
      { recordMetric: false },
    );

    const text = await metrics.render();
    expect(text).not.toContain('job_name="review-pr"');
  });

  it('fans the failure out to the user-notification hook', () => {
    mocks.notifyJobFailure.mockReset().mockResolvedValue(undefined);

    logJobFailure({
      jobName: 'generate-proposals',
      repositoryId: 'r1',
      errorKind: 'Error',
      message: 'invalid api key',
    });

    expect(mocks.notifyJobFailure).toHaveBeenCalledWith({
      jobName: 'generate-proposals',
      repositoryId: 'r1',
      errorKind: 'Error',
      message: 'invalid api key',
    });
  });

  it('never lets a broken notification hook escape into the caller', async () => {
    mocks.notifyJobFailure.mockReset().mockRejectedValue(new Error('db down'));

    expect(() =>
      logJobFailure({ jobName: 'run-task', errorKind: 'Error', message: 'x' }),
    ).not.toThrow();
    await expect(
      logJobFailure({ jobName: 'run-task', errorKind: 'Error', message: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('returns a promise that settles only after the notification hook, so callers can serialize it', async () => {
    // recordJobFailure awaits this before its caller rethrows: the in-run
    // notification must exist before the worker 'failed' hook re-enters the
    // funnel, or both flows race the unread dedupe.
    let resolveHook: (() => void) | undefined;
    mocks.notifyJobFailure.mockReset().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveHook = resolve;
        }),
    );

    let settled = false;
    const pending = logJobFailure({ jobName: 'run-task', errorKind: 'Error', message: 'x' }).then(
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    resolveHook?.();
    await pending;
    expect(settled).toBe(true);
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
