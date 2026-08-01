import { describe, expect, it } from 'vitest';
import { backlogBlocker } from '../src/routes/tasks.js';

// Locking tests for POST /tasks/:id/backlog: a task can be dragged back to the
// backlog (pending) only from an in-flight, non-terminal state. Terminal states
// are rejected (they cannot be resurrected into the backlog), and the plan-mode
// paused state is rejected (it is a distinct approval flow, not the backlog).

describe('backlogBlocker', () => {
  it.each(['queued', 'running', 'awaiting_review', 'reviewing_code'])(
    'allows returning a %s task to the backlog',
    (status) => {
      expect(backlogBlocker({ status })).toBeNull();
    },
  );

  it('allows returning a pending task (no-op, but not an error)', () => {
    expect(backlogBlocker({ status: 'pending' })).toBeNull();
  });

  it.each(['done', 'failed', 'closed'])('rejects terminal %s tasks', (status) => {
    expect(backlogBlocker({ status })).toBe(`task is ${status}, not in an in-flight state`);
  });

  it('rejects plan-mode (awaiting_plan_approval) tasks', () => {
    expect(backlogBlocker({ status: 'awaiting_plan_approval' })).toBe(
      'task is awaiting_plan_approval, not in an in-flight state',
    );
  });
});
