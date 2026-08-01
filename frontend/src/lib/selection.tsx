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
  const [prReviewRepoId, setPrReviewRepoId] = React.useState<string | null>(null);
  const [archivedTask, setArchivedTask] = React.useState<SelectedTask | null>(null);
  const [selectedServiceId, setSelectedServiceId] = React.useState<string | null>(() =>
    readPersisted<string | null>(SELECTED_SERVICE_STORAGE_KEY, null),
  );
  const [gitlemView, setGitlemView] = React.useState<null | 'grid' | string>(null);

  const selectTask = React.useCallback((task: SelectedTask | null) => {
    setSelectedTask(task);
    writePersisted(SELECTED_TASK_STORAGE_KEY, task);
    setLiveStatus(null);
    setArchivedRepoId(null);
    setArchivedTask(null);
    setSelectedServiceId(null);
    writePersisted(SELECTED_SERVICE_STORAGE_KEY, null);
  }, []);

  const selectRepository = React.useCallback((id: string | null) => {
    setSelectedRepositoryId(id);
    writePersisted(SELECTED_REPO_STORAGE_KEY, id);
  }, []);

  const openArchived = React.useCallback((repoId: string) => {
    setArchivedRepoId(repoId);
    setArchivedTask(null);
  }, []);
  const closeArchived = React.useCallback(() => {
    setArchivedRepoId(null);
    setArchivedTask(null);
  }, []);

  const openPrReview = React.useCallback((repoId: string) => {
    setPrReviewRepoId(repoId);
    setSelectedTask(null);
    writePersisted(SELECTED_TASK_STORAGE_KEY, null);
    setArchivedRepoId(null);
    setArchivedTask(null);
    setLiveStatus(null);
    setSelectedServiceId(null);
    writePersisted(SELECTED_SERVICE_STORAGE_KEY, null);
  }, []);
  const closePrReview = React.useCallback(() => setPrReviewRepoId(null), []);

  // The archived detail replaces the live console/service views but keeps the
  // archived list (archivedRepoId) open underneath for the way back.
  const openArchivedTask = React.useCallback((task: SelectedTask) => {
    setArchivedTask(task);
    setSelectedTask(null);
    writePersisted(SELECTED_TASK_STORAGE_KEY, null);
    setLiveStatus(null);
    setSelectedServiceId(null);
    writePersisted(SELECTED_SERVICE_STORAGE_KEY, null);
  }, []);
  const closeArchivedTask = React.useCallback(() => setArchivedTask(null), []);

  const selectService = React.useCallback((id: string | null) => {
    setSelectedServiceId(id);
    writePersisted(SELECTED_SERVICE_STORAGE_KEY, id);
    if (id !== null) {
      // The service detail replaces the console — clear task/archived views.
      setSelectedTask(null);
      writePersisted(SELECTED_TASK_STORAGE_KEY, null);
      setArchivedRepoId(null);
      setArchivedTask(null);
      setLiveStatus(null);
    }
  }, []);

  // The gitlem grid/detail replaces the console — clear the other pane
  // selections so only one center-pane view is active at a time.
  const clearOtherPanes = React.useCallback(() => {
    setSelectedTask(null);
    writePersisted(SELECTED_TASK_STORAGE_KEY, null);
    setArchivedRepoId(null);
    setArchivedTask(null);
    setLiveStatus(null);
    setSelectedServiceId(null);
    writePersisted(SELECTED_SERVICE_STORAGE_KEY, null);
    setPrReviewRepoId(null);
  }, []);
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
