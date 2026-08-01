import { ExternalLink, GitBranch, Loader2, Pause, Play, Smartphone, Square, X } from 'lucide-react';

import { useCancelTask, usePauseTask, useResumeTask, useStartTask } from '@/lib/hooks';
import { useWorkspaceSelection, type SelectedTask } from '@/lib/selection';
import type { ChangeSummary } from '@/lib/session-changes';
import { isSafeHttpUrl } from '@/lib/url';
import { StatusBadge } from '@/components/StatusBadge';
import { TokensBadge } from '@/components/TokensBadge';
import { DiffStat } from '@/components/console/ChangesDialog';
import { Button } from '@/components/ui/button';

const CANCELLABLE = new Set(['queued', 'running']);
const PAUSABLE = new Set(['queued', 'running', 'reviewing_code']);
const RUNNABLE_ON_DEVICE = new Set(['done', 'awaiting_review', 'reviewing_code']);

/** Live token consumption for the header badge, polled by the console pane. */
export interface ConsoleUsage {
  used: number;
  max: number | null;
  costUsd?: number | null;
}

/** Session-changes count next to the branch name; opens the changes dialog. */
export function ChangesBadge({
  summary,
  onOpen,
}: {
  summary: ChangeSummary;
  onOpen: () => void;
}) {
  if (summary.count === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title="View changes"
      aria-label={`View ${summary.count} ${summary.count === 1 ? 'change' : 'changes'}`}
      className="shrink-0 rounded px-1 py-0.5 font-mono text-[11px] hover:bg-muted"
    >
      <span className="text-muted-foreground">
        {summary.count} {summary.count === 1 ? 'change' : 'changes'}
      </span>{' '}
      <DiffStat added={summary.additions} removed={summary.deletions} />
    </button>
  );
}

/** Console header: task title, live status badge, branch and PR link. */
export function ConsoleHeader({
  task,
  status,
  usage,
  changes,
  onOpenChanges,
  onRunOnDevice,
}: {
  task: SelectedTask;
  status: string;
  /** Token usage of the task; the badge warns at ≥80% of the budget while running. */
  usage?: ConsoleUsage;
  /** Session file changes; the badge renders only when at least one exists. */
  changes?: ChangeSummary;
  /** Opens the GitHub-style changes dialog (branch name and count both open it). */
  onOpenChanges?: () => void;
  /** Opens the run-on-device dialog; rendered only for finished tasks. */
  onRunOnDevice?: () => void;
}) {
  const { selectTask } = useWorkspaceSelection();
  const cancelTask = useCancelTask();
  const startTask = useStartTask();
  const pauseTask = usePauseTask();
  const resumeTask = useResumeTask();
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
        <button
          type="button"
          onClick={onOpenChanges}
          title="View session changes"
          className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <GitBranch className="h-3.5 w-3.5" aria-hidden />
          <span className="max-w-40 truncate font-mono">{task.branchName}</span>
        </button>
      )}
      {changes && onOpenChanges && <ChangesBadge summary={changes} onOpen={onOpenChanges} />}
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
      {PAUSABLE.has(status) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1 px-2 text-xs"
          aria-label={`Pause ${task.title}`}
          title="Pause this process — resume continues from the saved transcript"
          disabled={pauseTask.isPending}
          onClick={() => pauseTask.mutate(task.id)}
        >
          {pauseTask.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Pause className="h-3.5 w-3.5" aria-hidden />
          )}
          Pause
        </Button>
      )}
      {status === 'paused' && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1 px-2 text-xs"
          aria-label={`Resume ${task.title}`}
          title="Resume this process"
          disabled={resumeTask.isPending}
          onClick={() => resumeTask.mutate(task.id)}
        >
          {resumeTask.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Play className="h-3.5 w-3.5" aria-hidden />
          )}
          Resume
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
