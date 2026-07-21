import { Terminal } from 'lucide-react';

import { isPendingProposal } from '@/lib/repo-tasks';
import { useWorkspaceSelection } from '@/lib/selection';

import { ConsoleHeader } from '@/components/console/ConsoleHeader';
import { ConsoleLog } from '@/components/console/ConsoleLog';
import { ArchivedPane } from '@/components/console/ArchivedPane';
import { ProposalDetail } from '@/components/console/ProposalDetail';
import { ComposerCard, TaskComposerFab } from '@/components/console/TaskComposer';
import { useTaskConsole } from '@/components/console/useTaskConsole';

function EmptyConsole() {
  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Agent console
        </span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <Terminal className="h-8 w-8 text-muted-foreground/50" aria-hidden />
        <p className="text-sm text-muted-foreground">Agent output will stream here.</p>
        <div className="w-full max-w-2xl text-left">
          <ComposerCard />
        </div>
      </div>
    </section>
  );
}

/**
 * CENTER pane — agent console.
 *
 * Shows the selected task header plus a live log: history is loaded via
 * GET /api/tasks/:id/events, then streamed over SSE (same endpoint, which
 * replays history first — replayed events are deduped by id). `status`
 * events update the header badge. See console/useTaskConsole.ts.
 * A pending proposal shows the editable ProposalDetail instead of the log;
 * once started it flips to queued and the log view takes over.
 * With no task selected the composer (ComposerCard) renders inline in the
 * empty console; once a task is selected, the floating + button opens the
 * same composer as the TaskComposerDialog modal. When the repo tree's
 * "show more" opens a repo's archived view (selection.archivedRepoId),
 * ArchivedPane replaces the console/composer until closed or a task is
 * selected.
 */
export function ConsolePane() {
  const { selectedTask, liveStatus, archivedRepoId } = useWorkspaceSelection();
  const taskId = selectedTask?.id ?? null;
  const consoleState = useTaskConsole(taskId);

  if (archivedRepoId) return <ArchivedPane repositoryId={archivedRepoId} />;
  if (!selectedTask) return <EmptyConsole />;

  const status = liveStatus ?? consoleState.historyStatus ?? selectedTask.status;
  const showProposalDetail = isPendingProposal(selectedTask) && status === 'pending';
  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      <ConsoleHeader task={selectedTask} status={status} />
      {showProposalDetail ? (
        <ProposalDetail key={selectedTask.id} taskId={selectedTask.id} />
      ) : (
        <ConsoleLog
          historyQuery={consoleState.historyQuery}
          historyLogs={consoleState.historyLogs}
          liveLogs={consoleState.liveLogs}
          streamError={consoleState.streamError}
        />
      )}
      <TaskComposerFab />
    </section>
  );
}
