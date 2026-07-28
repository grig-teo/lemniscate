import { ArchiveRestore, Loader2 } from 'lucide-react';

import { useUnarchiveTask, type Task } from '@/lib/hooks';
import { toSelectedTask } from '@/lib/repo-tasks';
import { useWorkspaceSelection } from '@/lib/selection';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';

/**
 * Greyed-out archived task. Clicking the row opens the read-only archived
 * detail (task details + console history) in the center pane; the unarchive
 * action brings the task back to the lists without opening the detail.
 */
export function ArchivedTaskRow({ task }: { task: Task }) {
  const { openArchivedTask } = useWorkspaceSelection();
  return (
    <li className="flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground">
      <button
        type="button"
        aria-label={`Open details of ${task.title}`}
        onClick={() => openArchivedTask(toSelectedTask(task))}
        className="min-w-0 flex-1 rounded px-1 py-0.5 text-left"
      >
        <span className="block truncate" title={task.title}>
          {task.title}
        </span>
      </button>
      <StatusBadge status={task.status} className="px-1.5 py-0 text-[10px] opacity-70" />
      <UnarchiveTaskButton task={task} />
    </li>
  );
}

/** Unarchive button that brings an archived task back to the lists. */
export function UnarchiveTaskButton({ task }: { task: Task }) {
  const unarchiveTask = useUnarchiveTask();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-5 w-5 shrink-0"
      aria-label={`Unarchive ${task.title}`}
      title="Unarchive"
      disabled={unarchiveTask.isPending}
      onClick={(event) => {
        event.stopPropagation();
        unarchiveTask.mutate(task.id);
      }}
    >
      {unarchiveTask.isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <ArchiveRestore className="h-3 w-3" />
      )}
    </Button>
  );
}
