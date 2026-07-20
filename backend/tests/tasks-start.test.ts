import { describe, expect, it } from 'vitest';
import { startBlocker } from '../src/routes/tasks.js';

// Locking tests for POST /tasks/:id/start eligibility: only pending proposal
// tasks can be started (queued → enqueued) by the user.

describe('startBlocker', () => {
  it('allows a pending proposal task', () => {
    expect(startBlocker({ kind: 'proposal', status: 'pending' })).toBeNull();
  });

  it('rejects prompt tasks even when pending', () => {
    expect(startBlocker({ kind: 'prompt', status: 'pending' })).toBe(
      'only proposal tasks can be started',
    );
  });

  it.each(['queued', 'running', 'awaiting_review', 'done', 'failed'])(
    'rejects proposal tasks that are %s',
    (status) => {
      expect(startBlocker({ kind: 'proposal', status })).toBe(`task is ${status}, not pending`);
    },
  );
});
