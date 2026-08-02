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
  const {
    selectedTask,
    archivedTask,
    archivedRepoId,
    selectedServiceId,
    prReviewRepoId,
    taskBoardRepoId,
    gitlemView,
    liveStatus,
  } = useWorkspaceSelection();
  return (
    <div>
      <span data-testid="selected">{selectedTask?.id ?? 'none'}</span>
      <span data-testid="archived-task">{archivedTask?.id ?? 'none'}</span>
      <span data-testid="archived-repo">{archivedRepoId ?? 'none'}</span>
      <span data-testid="service">{selectedServiceId ?? 'none'}</span>
      <span data-testid="pr-review-repo">{prReviewRepoId ?? 'none'}</span>
      <span data-testid="task-board">{taskBoardRepoId ?? 'none'}</span>
      <span data-testid="gitlem">{gitlemView ?? 'none'}</span>
      <span data-testid="live-status">{liveStatus ?? 'none'}</span>
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
      <button onClick={() => sel.openTaskBoard('r1')}>open-task-board</button>
      <button onClick={() => sel.openGitlemGrid()}>open-gitlem-grid</button>
      <button onClick={() => sel.setLiveStatus('running', 't1')}>push-own-status</button>
      <button onClick={() => sel.setLiveStatus('failed', 'other-task')}>push-stale-status</button>
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
    taskBoard: screen.getByTestId('task-board').textContent,
    gitlem: screen.getByTestId('gitlem').textContent,
    liveStatus: screen.getByTestId('live-status').textContent,
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
      taskBoard: 'none',
      gitlem: 'none',
      liveStatus: 'none',
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
      taskBoard: 'none',
      gitlem: 'none',
      liveStatus: 'none',
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

describe('center-pane exclusivity (one view replaces the previous)', () => {
  it('opening the PR list clears the task board and gitlem views', () => {
    renderSelection();
    click('open-task-board');
    click('open-pr-review');
    expect(state().taskBoard).toBe('none');
    expect(state().prReviewRepo).toBe('r1');

    click('open-gitlem-grid');
    click('open-pr-review');
    expect(state().gitlem).toBe('none');
    expect(state().prReviewRepo).toBe('r1');
  });

  it('opening a service clears the PR list and the task board', () => {
    renderSelection();
    click('open-task-board');
    click('open-pr-review');
    click('select-service');
    expect(state().prReviewRepo).toBe('none');
    expect(state().taskBoard).toBe('none');
    expect(state().service).toBe('s1');
  });

  it('opening the archived list clears the live task and the PR list', () => {
    renderSelection();
    click('select-task');
    click('open-pr-review');
    click('open-archived-list');
    expect(state().selected).toBe('none');
    expect(state().prReviewRepo).toBe('none');
    expect(state().archivedRepo).toBe('r1');
  });

  it('selecting a task clears the task board view', () => {
    renderSelection();
    click('open-task-board');
    click('select-task');
    expect(state().taskBoard).toBe('none');
    expect(state().selected).toBe('t1');
  });
});

describe('live status tagging', () => {
  it('surfaces the status of the selected task only', () => {
    renderSelection();
    click('select-task');
    click('push-own-status');
    expect(state().liveStatus).toBe('running');

    // A late SSE status from a previously selected task must not leak in.
    click('push-stale-status');
    expect(state().liveStatus).toBe('none');
  });

  it('clears the live status when another pane opens', () => {
    renderSelection();
    click('select-task');
    click('push-own-status');
    expect(state().liveStatus).toBe('running');
    click('open-pr-review');
    expect(state().liveStatus).toBe('none');
  });
});
