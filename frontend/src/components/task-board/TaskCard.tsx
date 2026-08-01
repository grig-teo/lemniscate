import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { EffortBadge } from '@/components/EffortBadge';
import { PriorityBadge } from '@/components/PriorityBadge';
import { Badge } from '@/components/ui/badge';
import { TERMINAL_STATUSES } from '@/lib/task-board';
import { toSelectedTask } from '@/lib/repo-tasks';
import { useWorkspaceSelection } from '@/lib/selection';
import type { Task } from '@/lib/task-types';

const TERMINAL_LABEL: Record<string, string> = { failed: 'failed', closed: 'closed' };

/** One draggable card in a Kanban column. Click (not drag) selects the task. */
export function TaskCard({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  const { selectTask } = useWorkspaceSelection();
  const terminal = TERMINAL_STATUSES.has(task.status);

  function open() {
    selectTask(toSelectedTask(task));
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={open}
      className={`flex cursor-grab flex-col gap-1.5 rounded-md border bg-card p-2.5 text-left shadow-sm active:cursor-grabbing ${
        isDragging ? 'opacity-50' : ''
      } ${terminal ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className="line-clamp-2 text-xs font-medium leading-snug">{task.title}</span>
        {terminal && (
          <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px] text-muted-foreground">
            {TERMINAL_LABEL[task.status] ?? task.status}
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {task.category && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[9px]">
            {task.category}
          </Badge>
        )}
        <PriorityBadge priority={task.priority} className="px-1.5 py-0 text-[9px]" />
        <EffortBadge effort={task.effort} className="px-1.5 py-0 text-[9px]" />
      </div>
    </div>
  );
}
