/**
 * Exclusive center-pane views: at most one is visible at a time. Each opener
 * in lib/selection.tsx routes through clearOtherPanes, so exactly one slot is
 * ever set — this component just maps that single active slot to its view.
 * Priority order is irrelevant in practice (only one slot can be set); the
 * chain documents the exclusivity contract and prevents stacking when a
 * second slot is somehow left open.
 */
import type { ReactElement, ReactNode } from 'react';

import { useWorkspaceSelection } from '@/lib/selection';
import type { SelectedTask } from '@/lib/selection';

import { ArchivedPane } from '@/components/console/ArchivedPane';
import { ArchivedTaskDetail } from '@/components/console/ArchivedTaskDetail';
import { PrListPane } from '@/components/PrListPane';
import { TaskBoard } from '@/components/task-board/TaskBoard';
import { GitlemRepoDetail } from '@/components/gitlem/GitlemRepoDetail';
import { GitlemReposGrid } from '@/components/gitlem/GitlemReposGrid';
import { ServicePane } from '@/components/services/ServicePane';

/** Renders the one active center-pane view, or `fallback` when none is set. */
export function ExclusiveCenterPaneView({ fallback }: { fallback: ReactNode }) {
  const {
    taskBoardRepoId,
    gitlemView,
    selectedServiceId,
    prReviewRepoId,
    archivedRepoId,
    archivedTask,
  } = useWorkspaceSelection();

  const exclusive: ReactElement | null = pickExclusiveView({
    taskBoardRepoId,
    gitlemView,
    selectedServiceId,
    prReviewRepoId,
    archivedRepoId,
    archivedTask,
  });
  return exclusive ?? <>{fallback}</>;
}

type SelectionSlots = {
  taskBoardRepoId: string | null;
  gitlemView: string | null;
  selectedServiceId: string | null;
  prReviewRepoId: string | null;
  archivedRepoId: string | null;
  archivedTask: unknown;
};

function pickExclusiveView(slots: SelectionSlots): ReactElement | null {
  if (slots.taskBoardRepoId) return <TaskBoard repositoryId={slots.taskBoardRepoId} />;
  if (slots.gitlemView && slots.gitlemView !== 'grid') return <GitlemRepoDetail name={slots.gitlemView} />;
  if (slots.gitlemView === 'grid') return <GitlemReposGrid />;
  if (slots.selectedServiceId) return <ServicePane serviceId={slots.selectedServiceId} />;
  if (slots.prReviewRepoId) return <PrListPane repositoryId={slots.prReviewRepoId} />;
  if (slots.archivedTask) return <ArchivedTaskDetail />;
  if (slots.archivedRepoId) return <ArchivedPane repositoryId={slots.archivedRepoId} />;
  return null;
}
