// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FollowUpSelect } from '@/components/console/FollowUpTaskSelect';
import type { Task } from '@/lib/task-types';

// Locks the follow-up dropdown's rendering: candidates of ANY status are
// listed (the eligibility rule itself lives in lib/follow-up.ts and is pinned
// by lib/follow-up.test.ts), each option shows a humanized status label, and
// the "No follow-up" clear option is always present.

// jsdom lacks scrollIntoView; Radix Select calls it when the content opens.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => undefined);

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

function openSelect(candidates: Task[], value: string | null = null) {
  render(<FollowUpSelect candidates={candidates} value={value} onChange={() => undefined} />);
  // Radix Select opens on ArrowDown from the focused trigger.
  const trigger = screen.getByRole('combobox', { name: 'Follow-up task' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
}

describe('FollowUpSelect', () => {
  it('renders the trigger and the No follow-up option', () => {
    openSelect([makeTask({ id: 'a', title: 'A' })]);
    // 'No follow-up' also renders in the closed trigger's selected value.
    expect(screen.getAllByText('No follow-up').length).toBeGreaterThan(0);
    expect(screen.getByText('A')).toBeTruthy();
  });

  it('lists candidates of any status with a humanized status label', () => {
    openSelect([
      makeTask({ id: 'p', title: 'Pending proposal', status: 'pending' }),
      makeTask({ id: 'r', title: 'Running prompt', status: 'running' }),
      makeTask({ id: 'rev', title: 'In review', status: 'awaiting_review' }),
      makeTask({ id: 'cr', title: 'Code review', status: 'reviewing_code' }),
      makeTask({ id: 'd', title: 'Finished', status: 'done' }),
    ]);
    const titles = ['Pending proposal', 'Running prompt', 'In review', 'Code review', 'Finished'];
    for (const title of titles) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByText('awaiting review')).toBeTruthy();
    expect(screen.getByText('reviewing code')).toBeTruthy();
  });

  it('renders with a pre-selected follow-up value', () => {
    render(
      <FollowUpSelect
        candidates={[makeTask({ id: 'p', title: 'Pending' })]}
        value="p"
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Follow-up task' })).toBeTruthy();
  });
});
