import * as React from 'react';
import { Terminal } from 'lucide-react';

import { isStartableTask } from '@/lib/repo-tasks';
import { IN_FLIGHT_POLL_INTERVAL_MS, isRunningStatus } from '@/lib/running-tasks';
import { useTask, useTaskRunTargets } from '@/lib/hooks';
import { useWorkspaceSelection } from '@/lib/selection';

import { ConsoleHeader } from '@/components/console/ConsoleHeader';
import { ConsoleLog } from '@/components/console/ConsoleLog';
import { ArchivedPane } from '@/components/console/ArchivedPane';
import { ProposalDetail } from '@/components/console/ProposalDetail';
import { ComposerCard, TaskComposerFab } from '@/components/console/TaskComposer';
import { ServiceDetail } from '@/components/services/ServiceDetail';
import { useTaskConsole } from '@/components/console/useTaskConsole';
import { RunTaskDialog } from '@/components/devices/RunTaskDialog';

function EmptyConsole() {
  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Agent console
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col items-center gap-4 px-4 py-8">
          <Terminal className="h-8 w-8 text-muted-foreground/50" aria-hidden />
          <p className="text-sm text-muted-foreground">Agent output will stream here.</p>
          <div className="w-full text-left">
            <ComposerCard />
          </div>
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
 * A pending task (proposal or saved-for-later prompt) shows the editable
 * ProposalDetail instead of the log; once started it flips to queued and
 * the log view takes over.
 * With no task selected the composer (ComposerCard) renders inline in the
 * empty console; once a task is selected, the floating + button opens the
 * same composer as the TaskComposerDialog modal. The + button is hidden
 * while the selected task is in flight (queued or running). When the repo tree's
 * "show more" opens a repo's archived view (selection.archivedRepoId),
 * ArchivedPane replaces the console/composer until closed or a task is
 * selected. When a task's live status flips to done, RunTaskDialog
 * auto-opens once (if a run target has an online device); it is also
 * reachable via the header's run-on-device button.
 */
export function ConsolePane() {
  const { selectedTask, liveStatus, archivedRepoId, selectedServiceId } = useWorkspaceSelection();
  const taskId = selectedTask?.id ?? null;
  const consoleState = useTaskConsole(taskId);

  const status = liveStatus ?? consoleState.historyStatus ?? selectedTask?.status ?? '';
  // Poll the task row while it runs so the header's token badge tracks the
  // worker-side persistTokenUsage writes (and the 80% budget warning fires).
  const taskQuery = useTask(taskId, {
    refetchInterval: status === 'running' ? IN_FLIGHT_POLL_INTERVAL_MS : false,
  });
  const usage = taskQuery.data
    ? {
        used: taskQuery.data.llmTokensUsed,
        max: taskQuery.data.maxTokensPerRun ?? null,
        costUsd: taskQuery.data.estimatedCostUsd ?? null,
      }
    : undefined;

  // Run-on-device dialog: auto-opens once per task when its live status flips
  // to done (and a target has an online device); also opened manually from the
  // console header button for done / awaiting_review tasks.
  const [runDialogOpen, setRunDialogOpen] = React.useState(false);
  const [autoOpenPending, setAutoOpenPending] = React.useState(false);
  const prevLiveStatusRef = React.useRef<string | null>(liveStatus);
  const autoOpenedForRef = React.useRef<string | null>(null);
  const runTargets = useTaskRunTargets(taskId, autoOpenPending);

  React.useEffect(() => {
    const prev = prevLiveStatusRef.current;
    prevLiveStatusRef.current = liveStatus;
    if (
      liveStatus === 'done' &&
      prev !== 'done' &&
      taskId !== null &&
      autoOpenedForRef.current !== taskId
    ) {
      setAutoOpenPending(true);
    }
  }, [liveStatus, taskId]);

  React.useEffect(() => {
    if (!autoOpenPending || taskId === null) return;
    if (runTargets.isError) {
      setAutoOpenPending(false);
      return;
    }
    if (!runTargets.data) return;
    setAutoOpenPending(false);
    const hasOnlineDevice = runTargets.data.some((target) =>
      target.devices.some((device) => device.online),
    );
    if (hasOnlineDevice) {
      autoOpenedForRef.current = taskId;
      setRunDialogOpen(true);
    }
  }, [autoOpenPending, taskId, runTargets.data, runTargets.isError]);

  if (selectedServiceId) return <ServiceDetail serviceId={selectedServiceId} />;
  if (archivedRepoId) return <ArchivedPane repositoryId={archivedRepoId} />;
  if (!selectedTask) return <EmptyConsole />;

  const showTaskDetail = isStartableTask(selectedTask) && status === 'pending';
  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      <ConsoleHeader
        task={selectedTask}
        status={status}
        usage={usage}
        onRunOnDevice={() => setRunDialogOpen(true)}
      />
      {showTaskDetail ? (
        <ProposalDetail key={selectedTask.id} taskId={selectedTask.id} />
      ) : (
        <>
          <ConsoleLog
            historyQuery={consoleState.historyQuery}
            historyLogs={consoleState.historyLogs}
            liveLogs={consoleState.liveLogs}
            streamError={consoleState.streamError}
          />
          {!isRunningStatus(status) && <TaskComposerFab />}
        </>
      )}
      <RunTaskDialog open={runDialogOpen} onOpenChange={setRunDialogOpen} task={selectedTask} />
    </section>
  );
}
