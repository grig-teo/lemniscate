// @vitest-environment jsdom
/**
 * Locking tests for the read-only archived-task detail pane: it shows the
 * task details (prompt, meta) plus the archived console log history, and
 * offers no mutating actions (no start/stop/rerun/unarchive).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task, TaskEventItem } from '@/lib/hooks';
import { createTestQueryClient } from '@/lib/queries/test-helpers';
import {
  useWorkspaceSelection,
  WorkspaceSelectionProvider,
  type SelectedTask,
} from '@/lib/selection';
import { ArchivedTaskDetail } from '@/components/console/ArchivedTaskDetail';

const selected: SelectedTask = {
  id: 'a1',
  title: 'Old archived task',
  status: 'done',
  kind: 'prompt',
  repositoryId: 'r1',
  branchName: 'lemniscate/old-task',
  prUrl: 'https://github.com/acme/repo/pull/7',
};

const taskDetail: Task = {
  id: 'a1',
  repositoryId: 'r1',
  kind: 'prompt',
  title: 'Old archived task',
  status: 'done',
  prompt: 'Fix the flaky checkout test',
  branchName: 'lemniscate/old-task',
  prUrl: 'https://github.com/acme/repo/pull/7',
  llmModel: 'claude-sonnet-4',
  archivedAt: '2024-03-01T00:00:00Z',
  llmTokensUsed: 1234,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-03-01T00:00:00Z',
};

const events: TaskEventItem[] = [
  { id: 'e1', kind: 'log', payload: { message: 'agent booted' }, createdAt: '2024-01-01T00:00:01Z' },
  { id: 'e2', kind: 'log', payload: { lines: ['ran tests', 'all green'] }, createdAt: '2024-01-01T00:00:02Z' },
  { id: 'e3', kind: 'status', payload: { status: 'done' }, createdAt: '2024-01-01T00:00:03Z' },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockTaskFetch() {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/api/tasks/a1/events')) return jsonResponse(events);
      if (url.endsWith('/api/tasks/a1')) return jsonResponse({ task: taskDetail });
      return jsonResponse({ error: 'not found' }, 404);
    }),
  );
  return { urls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => window.localStorage.clear());

function Harness() {
  const { archivedTask, openArchivedTask } = useWorkspaceSelection();
  return (
    <div>
      <button onClick={() => openArchivedTask(selected)}>open-detail</button>
      {archivedTask ? <ArchivedTaskDetail task={archivedTask} /> : <p>no detail</p>}
    </div>
  );
}

function renderDetail() {
  const queryClient = createTestQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceSelectionProvider>
        <Harness />
      </WorkspaceSelectionProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'open-detail' }));
}

describe('ArchivedTaskDetail', () => {
  it('shows the task details and the archived console history', async () => {
    const { urls } = mockTaskFetch();
    renderDetail();

    expect(screen.getByText('Old archived task')).toBeTruthy();
    expect(screen.getByText('Archived')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Fix the flaky checkout test')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('agent booted')).toBeTruthy());
    expect(screen.getByText(/ran tests/)).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('lemniscate/old-task')).toBeTruthy();
    expect(urls).toContain('/api/tasks/a1');
    expect(urls).toContain('/api/tasks/a1/events');
  });

  it('is read-only: no start, stop, rerun, or unarchive actions', async () => {
    mockTaskFetch();
    renderDetail();
    await waitFor(() => expect(screen.getByText('agent booted')).toBeTruthy());

    for (const name of [/start/i, /stop/i, /rerun/i, /unarchive/i, /run .* on a device/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('closes back to the previous view via the close button', async () => {
    mockTaskFetch();
    renderDetail();
    await waitFor(() => expect(screen.getByText('agent booted')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Close archived task details' }));

    expect(screen.getByText('no detail')).toBeTruthy();
  });
});
