import { describe, expect, it } from 'vitest';
import { buildResumeUpdate, pauseBlocker, resumeBlocker } from '../src/routes/tasks.js';

// Locking tests for POST /tasks/:id/pause and /tasks/:id/resume eligibility
// and the resume update. Pause flips an in-flight task to 'paused' (detected
// by the executor loop, which exits cleanly); resume re-queues a paused task
// without resetting its branch/PR — the workdir is kept so the run continues
// from the saved transcript, not from scratch (unlike rerun).

// Pausing is allowed only for an in-flight task the executor is actively
// working (queued/about to run, running, or reviewing_code — the same set
// that can be cancelled). Terminal/parked states have no live run to pause.
describe('pauseBlocker', () => {
  it.each(['queued', 'running', 'reviewing_code'])('allows an in-flight %s task', (status) => {
    expect(pauseBlocker({ status })).toBeNull();
  });

  it.each([
    'pending',
    'paused',
    'awaiting_plan_approval',
    'awaiting_review',
    'done',
    'failed',
    'closed',
  ])('rejects a %s task', (status) => {
    expect(pauseBlocker({ status })).toMatch(/not pausable/);
  });
});

// Resume is the inverse of pause: only a task that was paused can be resumed.
// Anything else has no paused run to replay.
describe('resumeBlocker', () => {
  it('allows a paused task', () => {
    expect(resumeBlocker({ status: 'paused' })).toBeNull();
  });

  it.each([
    'pending',
    'queued',
    'running',
    'reviewing_code',
    'awaiting_plan_approval',
    'awaiting_review',
    'done',
    'failed',
    'closed',
  ])('rejects a %s task', (status) => {
    expect(resumeBlocker({ status })).toMatch(/not paused/);
  });
});

// Resume re-queues the task but keeps the branch and PR link intact — the
// workdir is preserved across pause, so the resumed run continues from the
// saved transcript. Contrast with buildRerunUpdate, which resets the run.
describe('buildResumeUpdate', () => {
  it('re-queues the task without clearing branch, PR, or error', () => {
    expect(buildResumeUpdate()).toEqual({ status: 'queued' });
  });
});
