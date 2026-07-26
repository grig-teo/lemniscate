import { describe, expect, it, vi } from 'vitest';
import { errorKind, jobFailureFromError, logJobFailure } from '../src/lib/job-failure-log.js';

// Structured failure logging: job failures must be single grep-able JSON
// lines carrying job name, taskId, and error kind — the minimum for
// log-based alerting — instead of multi-line stack dumps.

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
