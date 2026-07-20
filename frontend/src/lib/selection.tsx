/**
 * Workspace selection state shared by the three panes (RepoTree, ConsolePane,
 * DiffPanel). Zustand-free: a small React context holding the selected task,
 * the live status override pushed by the SSE stream, and the diff events
 * forwarded to the right panel.
 */
import * as React from 'react';

export interface SelectedTask {
  id: string;
  title: string;
  status: string;
  kind?: string;
  branchName?: string | null;
  prUrl?: string | null;
}

export interface DiffEvent {
  key: string;
  payload: unknown;
  createdAt?: string;
}

interface WorkspaceSelectionValue {
  selectedTask: SelectedTask | null;
  /** Select a task (or clear with null); resets live status and diff events. */
  selectTask: (task: SelectedTask | null) => void;
  /** Live status from SSE `status` events; overrides selectedTask.status. */
  liveStatus: string | null;
  setLiveStatus: (status: string | null) => void;
  diffEvents: DiffEvent[];
  pushDiffEvent: (payload: unknown, createdAt?: string) => void;
}

const WorkspaceSelectionContext = React.createContext<WorkspaceSelectionValue | null>(null);

let diffEventCounter = 0;

export function WorkspaceSelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectedTask, setSelectedTask] = React.useState<SelectedTask | null>(null);
  const [liveStatus, setLiveStatus] = React.useState<string | null>(null);
  const [diffEvents, setDiffEvents] = React.useState<DiffEvent[]>([]);

  const selectTask = React.useCallback((task: SelectedTask | null) => {
    setSelectedTask(task);
    setLiveStatus(null);
    setDiffEvents([]);
  }, []);

  const pushDiffEvent = React.useCallback((payload: unknown, createdAt?: string) => {
    diffEventCounter += 1;
    setDiffEvents((prev) => [...prev, { key: `diff-${diffEventCounter}`, payload, createdAt }]);
  }, []);

  const value = React.useMemo<WorkspaceSelectionValue>(
    () => ({ selectedTask, selectTask, liveStatus, setLiveStatus, diffEvents, pushDiffEvent }),
    [selectedTask, selectTask, liveStatus, diffEvents, pushDiffEvent],
  );

  return (
    <WorkspaceSelectionContext.Provider value={value}>
      {children}
    </WorkspaceSelectionContext.Provider>
  );
}

export function useWorkspaceSelection(): WorkspaceSelectionValue {
  const ctx = React.useContext(WorkspaceSelectionContext);
  if (!ctx) {
    throw new Error('useWorkspaceSelection must be used within a WorkspaceSelectionProvider');
  }
  return ctx;
}
