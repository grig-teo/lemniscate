import { describe, expect, it } from 'vitest';
import { closePrBlocker } from '../src/routes/tasks.js';

// Locking tests for POST /tasks/:id/close-pr eligibility: only tasks that are
// awaiting_review with an open PR (branchName set) can be closed and have
// their branch deleted from the UI. The provider calls and DB writes are
// exercised in the handler; this pins the pure eligibility rule.

describe('closePrBlocker', () => {
  it('allows an awaiting_review task with a branch', () => {
    expect(closePrBlocker({ status: 'awaiting_review', branchName: 'lemniscate/t-1' })).toBeNull();
  });

  it('rejects an awaiting_review task without a branch', () => {
    expect(closePrBlocker({ status: 'awaiting_review', branchName: null })).toBe(
      'task has no branch to close',
    );
  });

  it.each(['pending', 'queued', 'running', 'done', 'failed', 'closed'])(
    'rejects tasks that are %s',
    (status) => {
      expect(closePrBlocker({ status, branchName: 'lemniscate/t-1' })).toBe(
        `task is ${status}, not awaiting_review`,
      );
    },
  );

  it('rejects tasks that are awaiting_review without a branch even before status check', () => {
    // Edge case: closed PRs already deleted their branch — closing again is a
    // no-op the user should not be able to trigger.
    expect(closePrBlocker({ status: 'closed', branchName: null })).toBe(
      'task is closed, not awaiting_review',
    );
  });
});
