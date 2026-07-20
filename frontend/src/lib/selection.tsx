/**
 * Workspace selection state shared by the panes (RepoTree, ConsolePane).
 * Zustand-free: a small React context holding the selected task and the
 * live status override pushed by the SSE stream.
 */
import * as React from 'react';

export interface SelectedTask {
  id: string;
  title: string;
  status: string;
  kind?: string;
  repositoryId?: string;
  branchName?: string | null;
  prUrl?: string | null;
}

interface WorkspaceSelectionValue {
  selectedTask: SelectedTask | null;
  /** Select a task (or clear with null); resets live status. */
  selectTask: (task: SelectedTask | null) => void;
  /** Live status from SSE `status` events; overrides selectedTask.status. */
  liveStatus: string | null;
  setLiveStatus: (status: string | null) => void;
}

const WorkspaceSelectionContext = React.createContext<WorkspaceSelectionValue | null>(null);

export function WorkspaceSelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectedTask, setSelectedTask] = React.useState<SelectedTask | null>(null);
  const [liveStatus, setLiveStatus] = React.useState<string | null>(null);

  const selectTask = React.useCallback((task: SelectedTask | null) => {
    setSelectedTask(task);
    setLiveStatus(null);
  }, []);

  const value = React.useMemo<WorkspaceSelectionValue>(
    () => ({ selectedTask, selectTask, liveStatus, setLiveStatus }),
    [selectedTask, selectTask, liveStatus],
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
