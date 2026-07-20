import { Terminal } from 'lucide-react';

import { useWorkspaceSelection } from '@/lib/selection';

import { ConsoleHeader } from '@/components/console/ConsoleHeader';
import { ConsoleLog } from '@/components/console/ConsoleLog';
import { useTaskConsole } from '@/components/console/useTaskConsole';

function EmptyConsole() {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Agent console
        </span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <Terminal className="h-8 w-8 text-muted-foreground/50" aria-hidden />
        <p className="text-sm text-muted-foreground">Agent output will stream here.</p>
        <p className="text-xs text-muted-foreground/70">
          Pick a repository on the left and start a task to watch the agent think, edit, and commit.
        </p>
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
 * events update the header badge; `diff` events are forwarded to the
 * workspace selection for the DiffPanel. See console/useTaskConsole.ts.
 */
export function ConsolePane() {
  const { selectedTask, liveStatus } = useWorkspaceSelection();
  const taskId = selectedTask?.id ?? null;
  const consoleState = useTaskConsole(taskId);

  if (!selectedTask) return <EmptyConsole />;

  const status = liveStatus ?? consoleState.historyStatus ?? selectedTask.status;
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      <ConsoleHeader task={selectedTask} status={status} />
      <ConsoleLog
        historyQuery={consoleState.historyQuery}
        historyLogs={consoleState.historyLogs}
        liveLogs={consoleState.liveLogs}
        streamError={consoleState.streamError}
      />
    </section>
  );
}
