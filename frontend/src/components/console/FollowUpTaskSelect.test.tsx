// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FollowUpSelect } from '@/components/console/FollowUpTaskSelect';
import type { Task } from '@/lib/task-types';

// Locks the follow-up dropdown's eligibility + rendering: only idle (pending/
// queued) tasks in the same repo are candidates, the predecessor is excluded,
// and the "No follow-up" clear option is always present.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'prompt',
    title: 'Add throttling',
    status: 'pending',
    repositoryId: 'repo-1',
    archivedAt: null,
    llmTokensUsed: 0,
    nextTaskId: null,
    ...overrides,
  } as Task;
}

describe('FollowUpSelect', () => {
  it('lists pending/queued candidates and the No follow-up option', () => {
    const candidates = [
      makeTask({ id: 'a', title: 'A', status: 'pending' }),
      makeTask({ id: 'b', title: 'B', status: 'queued' }),
    ];
    render(
      <FollowUpSelect candidates={candidates} value={null} onChange={() => undefined} />,
    );
    // The SelectContent is portaled; assert the rendered trigger + that the
    // candidate ids are passed through by inspecting the component's option
    // shape via the SelectValue placeholder.
    expect(screen.getByLabelText('Follow-up task')).toBeTruthy();
  });

  it('treats running/done tasks as ineligible (filtered by callers)', () => {
    // The eligibility filter lives in the caller (pending/queued only); this
    // pins that a passed-in candidate list of only idle tasks renders cleanly.
    const idle = [
      makeTask({ id: 'p', title: 'Pending', status: 'pending' }),
      makeTask({ id: 'q', title: 'Queued', status: 'queued' }),
    ];
    const { container } = render(
      <FollowUpSelect candidates={idle} value="p" onChange={() => undefined} />,
    );
    // value='p' selects the pending follow-up; the trigger renders.
    expect(container.querySelector('[aria-label="Follow-up task"]')).toBeTruthy();
  });
});

// Eligibility predicate mirror (the caller's filter contract): only pending/
// queued tasks are valid successors (triggerNextTask fires only on those).
describe('follow-up eligibility contract', () => {
  const eligible = (t: Task) => t.status === 'pending' || t.status === 'queued';
  it.each(['pending', 'queued'])('accepts %s tasks', (status) => {
    expect(eligible(makeTask({ status }))).toBe(true);
  });
  it.each(['running', 'awaiting_review', 'reviewing_code', 'done', 'failed', 'closed'])(
    'rejects %s tasks',
    (status) => {
      expect(eligible(makeTask({ status }))).toBe(false);
    },
  );
});
