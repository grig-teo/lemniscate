// @vitest-environment jsdom
/**
 * Locking tests for the archived-task detail selection: clicking an archived
 * row opens a read-only detail in the center pane (archivedTask), which
 * replaces the live console/service views and is cleared by every other
 * selection action.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  useWorkspaceSelection,
  WorkspaceSelectionProvider,
  type SelectedTask,
} from '@/lib/selection';

const ARCHIVED_TASK: SelectedTask = { id: 'a1', title: 'Old task', status: 'done' };
const ACTIVE_TASK: SelectedTask = { id: 't1', title: 'Live task', status: 'running' };

afterEach(() => cleanup());
beforeEach(() => window.localStorage.clear());

function SelectionState() {
  const { selectedTask, archivedTask, archivedRepoId, selectedServiceId, prReviewRepoId } =
    useWorkspaceSelection();
  return (
    <div>
      <span data-testid="selected">{selectedTask?.id ?? 'none'}</span>
      <span data-testid="archived-task">{archivedTask?.id ?? 'none'}</span>
      <span data-testid="archived-repo">{archivedRepoId ?? 'none'}</span>
      <span data-testid="service">{selectedServiceId ?? 'none'}</span>
      <span data-testid="pr-review-repo">{prReviewRepoId ?? 'none'}</span>
    </div>
  );
}

function SelectionActions() {
  const sel = useWorkspaceSelection();
  return (
    <div>
      <button onClick={() => sel.selectTask(ACTIVE_TASK)}>select-task</button>
      <button onClick={() => sel.openArchivedTask(ARCHIVED_TASK)}>open-archived-task</button>
      <button onClick={() => sel.closeArchivedTask()}>close-archived-task</button>
      <button onClick={() => sel.openArchived('r1')}>open-archived-list</button>
      <button onClick={() => sel.closeArchived()}>close-archived-list</button>
      <button onClick={() => sel.selectService('s1')}>select-service</button>
      <button onClick={() => sel.openPrReview('r1')}>open-pr-review</button>
      <button onClick={() => sel.closePrReview()}>close-pr-review</button>
    </div>
  );
}

function renderSelection() {
  return render(
    <WorkspaceSelectionProvider>
      <SelectionState />
      <SelectionActions />
    </WorkspaceSelectionProvider>,
  );
}

function state() {
  return {
    selected: screen.getByTestId('selected').textContent,
    archivedTask: screen.getByTestId('archived-task').textContent,
    archivedRepo: screen.getByTestId('archived-repo').textContent,
    service: screen.getByTestId('service').textContent,
    prReviewRepo: screen.getByTestId('pr-review-repo').textContent,
  };
}

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('archived-task selection', () => {
  it('opens the archived detail and clears the live task and service views', () => {
    renderSelection();
    click('select-task');
    click('open-archived-list');
    click('open-archived-task');

    expect(state()).toEqual({
      selected: 'none',
      archivedTask: 'a1',
      archivedRepo: 'r1', // list stays open underneath for the way back
      service: 'none',
      prReviewRepo: 'none',
    });
  });

  it('closeArchivedTask clears only the detail, keeping the archived list open', () => {
    renderSelection();
    click('open-archived-list');
    click('open-archived-task');
    click('close-archived-task');

    expect(state().archivedTask).toBe('none');
    expect(state().archivedRepo).toBe('r1');
  });

  it('selecting a live task clears the archived detail and list', () => {
    renderSelection();
    click('open-archived-list');
    click('open-archived-task');
    click('select-task');

    expect(state()).toEqual({
      selected: 't1',
      archivedTask: 'none',
      archivedRepo: 'none',
      service: 'none',
      prReviewRepo: 'none',
    });
  });

  it('opening a service clears the archived detail', () => {
    renderSelection();
    click('open-archived-task');
    click('select-service');

    expect(state().archivedTask).toBe('none');
    expect(state().service).toBe('s1');
  });

  it('opening or closing the archived list clears the detail', () => {
    renderSelection();
    click('open-archived-task');
    click('open-archived-list');
    expect(state().archivedTask).toBe('none');

    click('open-archived-task');
    click('close-archived-list');
    expect(state().archivedTask).toBe('none');
    expect(state().archivedRepo).toBe('none');
  });
});
