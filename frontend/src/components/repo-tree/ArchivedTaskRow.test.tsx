// @vitest-environment jsdom
/**
 * Locking tests for the clickable archived row: the row opens the read-only
 * archived-task detail (selection.archivedTask), while the unarchive action
 * keeps working without triggering the detail view.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '@/lib/hooks';
import {
  createTestQueryClient,
  mockFetchSequence,
} from '@/lib/queries/test-helpers';
import { useWorkspaceSelection, WorkspaceSelectionProvider } from '@/lib/selection';
import { ArchivedTaskRow } from '@/components/repo-tree/ArchivedTaskRow';

const task: Task = {
  id: 'a1',
  repositoryId: 'r1',
  kind: 'prompt',
  title: 'Old archived task',
  status: 'done',
  archivedAt: '2024-03-01T00:00:00Z',
  llmTokensUsed: 0,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ArchivedTaskState() {
  const { archivedTask } = useWorkspaceSelection();
  return <span data-testid="archived-task">{archivedTask?.id ?? 'none'}</span>;
}

function renderRow() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceSelectionProvider>
        <ul>
          <ArchivedTaskRow task={task} />
        </ul>
        <ArchivedTaskState />
      </WorkspaceSelectionProvider>
    </QueryClientProvider>,
  );
}

describe('ArchivedTaskRow', () => {
  it('opens the read-only archived detail when the row is clicked', () => {
    mockFetchSequence();
    renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'Open details of Old archived task' }));

    expect(screen.getByTestId('archived-task').textContent).toBe('a1');
  });

  it('unarchives from the row action without opening the detail', async () => {
    const { calls } = mockFetchSequence({ status: 200, json: {} });
    renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'Unarchive Old archived task' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/tasks/a1/unarchive',
        method: 'POST',
        body: undefined,
      }),
    );
    expect(screen.getByTestId('archived-task').textContent).toBe('none');
  });
});
