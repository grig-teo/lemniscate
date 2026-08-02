/**
 * Workspace selection state shared by the panes (RepoTree, ConsolePane).
 * Zustand-free: a small React context holding the selected task and the
 * live status override pushed by the SSE stream.
 */
import * as React from 'react';

import { readPersisted, writePersisted } from '@/lib/persist';

const SELECTED_TASK_STORAGE_KEY = 'lemniscate.selected-task';
const SELECTED_REPO_STORAGE_KEY = 'lemniscate.selected-repo';
const SELECTED_SERVICE_STORAGE_KEY = 'lemniscate.selected-service';

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
  /** Repo whose PR review pane is open in the center pane. */
  prReviewRepoId: string | null;
  openPrReview: (repoId: string) => void;
  closePrReview: () => void;
  /** Archived task whose read-only detail (details + console history) is open. */
  archivedTask: SelectedTask | null;
  openArchivedTask: (task: SelectedTask) => void;
  closeArchivedTask: () => void;
  /** Service whose detail pane is open in the center pane. */
  selectedServiceId: string | null;
  selectService: (id: string | null) => void;
  /** Gitlem view open in the center pane: null = closed, 'grid' = repos grid, a repo name = detail. */
  gitlemView: null | 'grid' | string;
  openGitlemGrid: () => void;
  openGitlemRepo: (name: string) => void;
  closeGitlemView: () => void;
  /** Repository whose Kanban task board is open in the center pane. */
  taskBoardRepoId: string | null;
  openTaskBoard: (repoId: string) => void;
  closeTaskBoard: () => void;
  /** Live status from SSE `status` events; overrides selectedTask.status. */
  liveStatus: string | null;
  /** Push a live status; tagged with the task it belongs to so a late event
   * from a previously selected task's stream cannot leak into the new view. */
  setLiveStatus: (status: string | null, taskId?: string) => void;
}

const WorkspaceSelectionContext = React.createContext<WorkspaceSelectionValue | null>(null);

export function WorkspaceSelectionProvider({ children }: { children: React.ReactNode }) {
  // Hydrate from localStorage; a stale id 404s gracefully in task queries.
  const [selectedTask, setSelectedTask] = React.useState<SelectedTask | null>(() =>
    readPersisted<SelectedTask | null>(SELECTED_TASK_STORAGE_KEY, null),
  );
  const [selectedRepositoryId, setSelectedRepositoryId] = React.useState<string | null>(() =>
    readPersisted<string | null>(SELECTED_REPO_STORAGE_KEY, null),
  );
  const [archivedRepoId, setArchivedRepoId] = React.useState<string | null>(null);
  const [prReviewRepoId, setPrReviewRepoId] = React.useState<string | null>(null);
  const [archivedTask, setArchivedTask] = React.useState<SelectedTask | null>(null);
  const [selectedServiceId, setSelectedServiceId] = React.useState<string | null>(() =>
    readPersisted<string | null>(SELECTED_SERVICE_STORAGE_KEY, null),
  );
  const [gitlemView, setGitlemView] = React.useState<null | 'grid' | string>(null);
  const [taskBoardRepoId, setTaskBoardRepoId] = React.useState<string | null>(null);
  // Live status is stored with the task it came from: an SSE event that
  // arrives after the user already clicked another task must not override
  // the new selection's view (e.g. flipping a pending proposal out of its
  // editor into the log view).
  const [liveStatusEvent, setLiveStatusEvent] = React.useState<{
    taskId: string;
    status: string;
  } | null>(null);

  const setLiveStatus = React.useCallback((status: string | null, taskId?: string) => {
    setLiveStatusEvent(status !== null && taskId ? { taskId, status } : null);
  }, []);

  // Every opener routes through this: only one center-pane view (console,
  // archived, PR list, service, gitlem, task board) may be active at a time.
  const clearOtherPanes = React.useCallback(() => {
    setSelectedTask(null);
    writePersisted(SELECTED_TASK_STORAGE_KEY, null);
    setArchivedRepoId(null);
    setArchivedTask(null);
    setLiveStatusEvent(null);
    setSelectedServiceId(null);
    writePersisted(SELECTED_SERVICE_STORAGE_KEY, null);
    setPrReviewRepoId(null);
    setGitlemView(null);
    setTaskBoardRepoId(null);
  }, []);

  const selectTask = React.useCallback(
    (task: SelectedTask | null) => {
      clearOtherPanes();
      setSelectedTask(task);
      writePersisted(SELECTED_TASK_STORAGE_KEY, task);
    },
    [clearOtherPanes],
  );

  const selectRepository = React.useCallback((id: string | null) => {
    setSelectedRepositoryId(id);
    writePersisted(SELECTED_REPO_STORAGE_KEY, id);
  }, []);

  const openArchived = React.useCallback(
    (repoId: string) => {
      clearOtherPanes();
      setArchivedRepoId(repoId);
    },
    [clearOtherPanes],
  );
  const closeArchived = React.useCallback(() => {
    setArchivedRepoId(null);
    setArchivedTask(null);
  }, []);

  const openPrReview = React.useCallback(
    (repoId: string) => {
      clearOtherPanes();
      setPrReviewRepoId(repoId);
    },
    [clearOtherPanes],
  );
  const closePrReview = React.useCallback(() => setPrReviewRepoId(null), []);

  // The archived detail replaces every other center-pane view but keeps the
  // archived list (archivedRepoId) open underneath for the way back.
  const openArchivedTask = React.useCallback((task: SelectedTask) => {
    setSelectedTask(null);
    writePersisted(SELECTED_TASK_STORAGE_KEY, null);
    setLiveStatusEvent(null);
    setSelectedServiceId(null);
    writePersisted(SELECTED_SERVICE_STORAGE_KEY, null);
    setPrReviewRepoId(null);
    setGitlemView(null);
    setTaskBoardRepoId(null);
    setArchivedTask(task);
  }, []);
  const closeArchivedTask = React.useCallback(() => setArchivedTask(null), []);

  const selectService = React.useCallback(
    (id: string | null) => {
      // A service detail replaces every other center-pane view; clearing the
      // selection (null) only closes the service view itself.
      if (id !== null) clearOtherPanes();
      setSelectedServiceId(id);
      writePersisted(SELECTED_SERVICE_STORAGE_KEY, id);
    },
    [clearOtherPanes],
  );

  const openGitlemGrid = React.useCallback(() => {
    clearOtherPanes();
    setGitlemView('grid');
  }, [clearOtherPanes]);
  const openGitlemRepo = React.useCallback(
    (name: string) => {
      clearOtherPanes();
      setGitlemView(name);
    },
    [clearOtherPanes],
  );
  const closeGitlemView = React.useCallback(() => setGitlemView(null), []);
  const openTaskBoard = React.useCallback(
    (repoId: string) => {
      clearOtherPanes();
      setTaskBoardRepoId(repoId);
    },
    [clearOtherPanes],
  );
  const closeTaskBoard = React.useCallback(() => setTaskBoardRepoId(null), []);

  // Exposed live status: only when it belongs to the currently selected task.
  const liveStatus =
    liveStatusEvent && liveStatusEvent.taskId === selectedTask?.id
      ? liveStatusEvent.status
      : null;

  const value = React.useMemo<WorkspaceSelectionValue>(
    () => ({
      selectedTask,
      selectTask,
      selectedRepositoryId,
      selectRepository,
      archivedRepoId,
      openArchived,
      closeArchived,
      prReviewRepoId,
      openPrReview,
      closePrReview,
      archivedTask,
      openArchivedTask,
      closeArchivedTask,
      selectedServiceId,
      selectService,
      gitlemView,
      openGitlemGrid,
      openGitlemRepo,
      closeGitlemView,
      taskBoardRepoId,
      openTaskBoard,
      closeTaskBoard,
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
      prReviewRepoId,
      openPrReview,
      closePrReview,
      archivedTask,
      openArchivedTask,
      closeArchivedTask,
      selectedServiceId,
      selectService,
      gitlemView,
      openGitlemGrid,
      openGitlemRepo,
      closeGitlemView,
      taskBoardRepoId,
      openTaskBoard,
      closeTaskBoard,
      liveStatus,
      setLiveStatus,
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
