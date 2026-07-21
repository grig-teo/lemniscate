import { ArchiveRestore, Loader2 } from 'lucide-react';

import { useUnarchiveTask, type Task } from '@/lib/hooks';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';

/** Greyed-out archived task with an unarchive action; not selectable. */
export function ArchivedTaskRow({ task }: { task: Task }) {
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground/70">
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
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
