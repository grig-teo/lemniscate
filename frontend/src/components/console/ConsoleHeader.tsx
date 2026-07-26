import { ExternalLink, GitBranch, Loader2, Play, Smartphone, Square, X } from 'lucide-react';

import { useCancelTask, useStartTask } from '@/lib/hooks';
import { useWorkspaceSelection, type SelectedTask } from '@/lib/selection';
import { isSafeHttpUrl } from '@/lib/url';
import { StatusBadge } from '@/components/StatusBadge';
import { TokensBadge } from '@/components/TokensBadge';
import { Button } from '@/components/ui/button';

const CANCELLABLE = new Set(['queued', 'running']);
const RUNNABLE_ON_DEVICE = new Set(['done', 'awaiting_review']);

/** Live token consumption for the header badge, polled by the console pane. */
export interface ConsoleUsage {
  used: number;
  max: number | null;
  costUsd?: number | null;
}

/** Console header: task title, live status badge, branch and PR link. */
export function ConsoleHeader({
  task,
  status,
  usage,
  onRunOnDevice,
}: {
  task: SelectedTask;
  status: string;
  /** Token usage of the task; the badge warns at ≥80% of the budget while running. */
  usage?: ConsoleUsage;
  /** Opens the run-on-device dialog; rendered only for finished tasks. */
  onRunOnDevice?: () => void;
}) {
  const { selectTask } = useWorkspaceSelection();
  const cancelTask = useCancelTask();
  const startTask = useStartTask();
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={task.title}>
        {task.title}
      </span>
      <StatusBadge status={status} />
      {usage && (
        <TokensBadge
          used={usage.used}
          max={usage.max}
          running={status === 'running'}
          costUsd={usage.costUsd ?? null}
        />
      )}
      {task.branchName && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5" aria-hidden />
          <span className="max-w-40 truncate font-mono">{task.branchName}</span>
        </span>
      )}
      {task.prUrl && isSafeHttpUrl(task.prUrl) && (
        <a
          href={task.prUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-xs text-blue-500 hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          Pull request
        </a>
      )}
      {status === 'pending' && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          aria-label={`Start ${task.title}`}
          title="Start this task"
          disabled={startTask.isPending}
          onClick={() => startTask.mutate(task.id)}
        >
          {startTask.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Play className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      )}
      {RUNNABLE_ON_DEVICE.has(status) && onRunOnDevice && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          aria-label={`Run ${task.title} on a device`}
          title="Run result on your device"
          onClick={onRunOnDevice}
        >
          <Smartphone className="h-3.5 w-3.5" aria-hidden />
        </Button>
      )}
      {CANCELLABLE.has(status) && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-destructive"
          aria-label={`Stop ${task.title}`}
          title="Stop this process"
          disabled={cancelTask.isPending}
          onClick={() => cancelTask.mutate(task.id)}
        >
          {cancelTask.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Square className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        aria-label="Hide console (process keeps running)"
        title="Hide console — the process keeps running"
        onClick={() => selectTask(null)}
      >
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
