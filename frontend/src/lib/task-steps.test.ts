/**
 * Locking tests for the task implementation-steps model: the ordered steps
 * shown on the right-edge rail (TaskStepsRail) and the per-step tone
 * (complete/current/upcoming/failed) derived from a task status.
 */
import { describe, expect, it } from 'vitest';

import { TASK_STEPS, stepIndexForStatus, stepTone } from '@/lib/task-steps';

describe('TASK_STEPS', () => {
  it('follows the task lifecycle order', () => {
    expect(TASK_STEPS.map((step) => step.status)).toEqual([
      'pending',
      'queued',
      'running',
      'reviewing_code',
      'awaiting_review',
      'done',
    ]);
  });

  it('has a human label for every step', () => {
    for (const step of TASK_STEPS) expect(step.label.length).toBeGreaterThan(0);
  });
});

describe('stepIndexForStatus', () => {
  it('returns the index of each lifecycle status', () => {
    expect(stepIndexForStatus('pending')).toBe(0);
    expect(stepIndexForStatus('running')).toBe(2);
    expect(stepIndexForStatus('done')).toBe(TASK_STEPS.length - 1);
  });

  it('returns -1 for unknown statuses', () => {
    expect(stepIndexForStatus('archived')).toBe(-1);
    expect(stepIndexForStatus('')).toBe(-1);
  });
});

describe('stepTone', () => {
  it('marks earlier steps complete, the current one current, later ones upcoming', () => {
    expect(stepTone(0, 'running')).toBe('complete');
    expect(stepTone(2, 'running')).toBe('current');
    expect(stepTone(3, 'running')).toBe('upcoming');
  });

  it('marks every step complete once the task is done', () => {
    for (let index = 0; index < TASK_STEPS.length; index += 1) {
      expect(stepTone(index, 'done')).toBe('complete');
    }
  });

  it('marks the running step failed for a failed task', () => {
    expect(stepTone(1, 'failed')).toBe('complete');
    expect(stepTone(2, 'failed')).toBe('failed');
    expect(stepTone(3, 'failed')).toBe('upcoming');
  });

  it('marks the PR-review step failed for a closed task', () => {
    expect(stepTone(3, 'closed')).toBe('complete');
    expect(stepTone(4, 'closed')).toBe('failed');
    expect(stepTone(5, 'closed')).toBe('upcoming');
  });

  it('leaves every step upcoming for an unknown status', () => {
    for (let index = 0; index < TASK_STEPS.length; index += 1) {
      expect(stepTone(index, 'bogus')).toBe('upcoming');
    }
  });
});
