import { ExternalLink, GitBranch, X } from 'lucide-react';

import { useWorkspaceSelection, type SelectedTask } from '@/lib/selection';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';

/** Console header: task title, live status badge, branch and PR link. */
export function ConsoleHeader({ task, status }: { task: SelectedTask; status: string }) {
  const { selectTask } = useWorkspaceSelection();
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
