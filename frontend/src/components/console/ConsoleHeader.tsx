import { ExternalLink, GitBranch, Loader2, Play, Square, X } from 'lucide-react';

import { useCancelTask, useStartTask } from '@/lib/hooks';
import { useWorkspaceSelection, type SelectedTask } from '@/lib/selection';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';

const CANCELLABLE = new Set(['queued', 'running']);

/** Console header: task title, live status badge, branch and PR link. */
export function ConsoleHeader({ task, status }: { task: SelectedTask; status: string }) {
  const { selectTask } = useWorkspaceSelection();
  const cancelTask = useCancelTask();
  const startTask = useStartTask();
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={task.title}>
        {task.title}
      </span>
      <StatusBadge status={status} />
      {task.branchName && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5" aria-hidden />
          <span className="max-w-40 truncate font-mono">{task.branchName}</span>
        </span>
      )}
      {task.prUrl && (
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
