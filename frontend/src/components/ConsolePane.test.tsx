// @vitest-environment jsdom
/**
 * Locking test for the center (right-side) detail pane: clicking between a
 * pending proposal, a running task, and an archived task must REPLACE the
 * open view — exactly one detail view is visible at any time, never a
 * column of stacked views.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '@/lib/hooks';
import { createTestQueryClient } from '@/lib/queries/test-helpers';
import {
  useWorkspaceSelection,
  WorkspaceSelectionProvider,
  type SelectedTask,
} from '@/lib/selection';
import { ConsolePane } from '@/components/ConsolePane';

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  close() {}
}

function baseTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    repositoryId: 'repo-1',
    kind: 'prompt',
    title: 'Task',
    status: 'pending',
    archivedAt: null,
    llmTokensUsed: 0,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

const PROPOSAL_A = baseTask({ id: 'a1', kind: 'proposal', title: 'Proposal Alpha' });
const PROPOSAL_B = baseTask({ id: 'b2', kind: 'proposal', title: 'Proposal Beta' });
const RUNNING_TASK = baseTask({ id: 'c3', kind: 'prompt', title: 'Task Gamma', status: 'running' });
const ARCHIVED_TASK = baseTask({ id: 'd4', kind: 'prompt', title: 'Archived Delta', status: 'done' });
const KNOWN_TASKS = [PROPOSAL_A, PROPOSAL_B, RUNNING_TASK, ARCHIVED_TASK];

// The right-side Objective/Plan panel is driven by agent_step events with
// subtype 'objective' (detail holds the goal text). Each proposal carries a
// distinct objective so the test can tell one task's panel from the other.
const OBJECTIVES: Record<string, string> = {
  a1: 'Build the Alpha widget',
  b2: 'Build the Beta widget',
};

function objectiveStep(taskId: string): { id: string; kind: string; payload: unknown } {
  return {
    id: `${taskId}-obj`,
    kind: 'agent_step',
    payload: {
      stepId: `${taskId}-obj`,
      kind: 'assistant',
      status: 'done',
      subtype: 'objective',
      title: 'Objective',
      detail: OBJECTIVES[taskId],
    },
  };
}

function toSelected(task: Task): SelectedTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    kind: task.kind,
    repositoryId: task.repositoryId,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockApiFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const task = KNOWN_TASKS.find((candidate) => url.endsWith(`/api/tasks/${candidate.id}`));
      if (task) return jsonResponse({ task });
      if (url.includes('/api/tasks') && url.endsWith('/events')) {
        const taskId = KNOWN_TASKS.find((candidate) =>
          url.includes(`/api/tasks/${candidate.id}/events`),
        )?.id;
        return jsonResponse(taskId && OBJECTIVES[taskId] ? [objectiveStep(taskId)] : []);
      }
      if (url.endsWith('/api/repositories')) return jsonResponse({ repositories: [] });
      return jsonResponse({ error: 'not found' }, 404);
    }),
  );
}

function SelectionButtons() {
  const { selectTask, openArchivedTask } = useWorkspaceSelection();
  return (
    <div>
      <button onClick={() => selectTask(toSelected(PROPOSAL_A))}>open-proposal-a</button>
      <button onClick={() => selectTask(toSelected(PROPOSAL_B))}>open-proposal-b</button>
      <button onClick={() => selectTask(toSelected(RUNNING_TASK))}>open-running-task</button>
      <button onClick={() => openArchivedTask(toSelected(ARCHIVED_TASK))}>open-archived-task</button>
    </div>
  );
}

function renderPane() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceSelectionProvider>
        <SelectionButtons />
        <ConsolePane />
      </WorkspaceSelectionProvider>
    </QueryClientProvider>,
  );
}

/** The pane must render exactly one <section> detail view. */
function visibleDetailSections(): HTMLElement[] {
  return Array.from(document.querySelectorAll('section'));
}

async function click(name: string) {
  // act() flushes the selection state updates through the provider.
  await act(async () => {
    screen.getByRole('button', { name }).click();
  });
}

beforeEach(() => {
  window.localStorage.clear();
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  mockApiFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConsolePane exclusive detail view', () => {
  it('replaces one proposal with the next instead of stacking them', async () => {
    renderPane();
    await click('open-proposal-a');
    await click('open-proposal-b');
    expect(visibleDetailSections()).toHaveLength(1);
    expect(await screen.findByDisplayValue('Proposal Beta')).toBeTruthy();
    expect(screen.queryByDisplayValue('Proposal Alpha')).toBeNull();
  });

  it('replaces a proposal with a running-task console', async () => {
    renderPane();
    await click('open-proposal-a');
    await click('open-running-task');
    expect(visibleDetailSections()).toHaveLength(1);
    await waitFor(() => expect(screen.getByText('Task Gamma')).toBeTruthy());
    expect(screen.queryByDisplayValue('Proposal Alpha')).toBeNull();
  });

  it('replaces a running-task console with an archived-task detail', async () => {
    renderPane();
    await click('open-running-task');
    await click('open-archived-task');
    await waitFor(() =>
      expect(screen.getByLabelText('Archived task details')).toBeTruthy(),
    );
    expect(visibleDetailSections()).toHaveLength(1);
    expect(screen.queryByText('Task Gamma')).toBeNull();
  });

  it('replaces an archived-task detail with a proposal editor', async () => {
    renderPane();
    await click('open-archived-task');
    await click('open-proposal-a');
    expect(visibleDetailSections()).toHaveLength(1);
    expect(await screen.findByDisplayValue('Proposal Alpha')).toBeTruthy();
    expect(screen.queryByLabelText('Archived task details')).toBeNull();
  });

  it('replaces the right-side Objective/Plan panel instead of stacking it', async () => {
    // React keys must be unique among siblings. Two right-side overlays
    // (ObjectiveTodoPanel + TaskStepsRail) were both keyed on the raw task id,
    // so switching tasks could leave the previous task's panel mounted —
    // exactly the "collecting in the column" bug.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPane();

    await click('open-proposal-a');
    expect(await screen.findByText('Build the Alpha widget')).toBeTruthy();

    await click('open-proposal-b');
    expect(await screen.findByText('Build the Beta widget')).toBeTruthy();
    // The previous task's objective must be gone — replaced, not stacked.
    expect(screen.queryByText('Build the Alpha widget')).toBeNull();

    const duplicateKeyWarnings = errorSpy.mock.calls.filter((call) =>
      String(call[0]).includes('Encountered two children with the same key'),
    );
    expect(duplicateKeyWarnings).toHaveLength(0);
    errorSpy.mockRestore();
  });
});
