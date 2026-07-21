/**
 * Workspace selection state shared by the panes (RepoTree, ConsolePane).
 * Zustand-free: a small React context holding the selected task and the
 * live status override pushed by the SSE stream.
 */
import * as React from 'react';

import { readPersisted, writePersisted } from '@/lib/persist';

const SELECTED_TASK_STORAGE_KEY = 'lemniscate.selected-task';
const SELECTED_REPO_STORAGE_KEY = 'lemniscate.selected-repo';

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
  /** Select a task (or clear with null); resets live status and the archived view. */
  selectTask: (task: SelectedTask | null) => void;
  /** Repository selected in the repo tree; defaults the composer target. */
  selectedRepositoryId: string | null;
  selectRepository: (id: string | null) => void;
  /** Repo whose full archived task list is open in the center pane. */
  archivedRepoId: string | null;
  openArchived: (repoId: string) => void;
  closeArchived: () => void;
  /** Live status from SSE `status` events; overrides selectedTask.status. */
  liveStatus: string | null;
  setLiveStatus: (status: string | null) => void;
}

const WorkspaceSelectionContext = React.createContext<WorkspaceSelectionValue | null>(null);

export function WorkspaceSelectionProvider({ children }: { children: React.ReactNode }) {
  // Hydrate from localStorage; a stale id 404s gracefully in task queries.
  const [selectedTask, setSelectedTask] = React.useState<SelectedTask | null>(() =>
    readPersisted<SelectedTask | null>(SELECTED_TASK_STORAGE_KEY, null),
  );
  const [liveStatus, setLiveStatus] = React.useState<string | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = React.useState<string | null>(() =>
    readPersisted<string | null>(SELECTED_REPO_STORAGE_KEY, null),
  );
  const [archivedRepoId, setArchivedRepoId] = React.useState<string | null>(null);

  const selectTask = React.useCallback((task: SelectedTask | null) => {
    setSelectedTask(task);
    writePersisted(SELECTED_TASK_STORAGE_KEY, task);
    setLiveStatus(null);
    setArchivedRepoId(null);
  }, []);

  const selectRepository = React.useCallback((id: string | null) => {
    setSelectedRepositoryId(id);
    writePersisted(SELECTED_REPO_STORAGE_KEY, id);
  }, []);

  const openArchived = React.useCallback((repoId: string) => setArchivedRepoId(repoId), []);
  const closeArchived = React.useCallback(() => setArchivedRepoId(null), []);

  const value = React.useMemo<WorkspaceSelectionValue>(
    () => ({
      selectedTask,
      selectTask,
      selectedRepositoryId,
      selectRepository,
      archivedRepoId,
      openArchived,
      closeArchived,
      liveStatus,
      setLiveStatus,
    }),
    [
      selectedTask,
      selectTask,
      selectedRepositoryId,
      selectRepository,
      archivedRepoId,
      openArchived,
      closeArchived,
      liveStatus,
    ],
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
