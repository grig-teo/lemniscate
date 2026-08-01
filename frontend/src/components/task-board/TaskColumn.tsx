import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';

import { Badge } from '@/components/ui/badge';
import { TaskCard } from '@/components/task-board/TaskCard';
import type { BoardColumn } from '@/lib/task-board';

/**
 * A scrollable Kanban column: header (title + count) + sortable card list.
 * The column wrapper is itself a droppable (useDroppable, id = column.id) so a
 * card can be dropped anywhere on the column — including into an empty column
 * or onto the column background — not only onto another card.
 */
export function TaskColumn({ column }: { column: BoardColumn }) {
  const { setNodeRef } = useDroppable({ id: column.id });
  return (
    <div
      ref={setNodeRef}
      className="flex min-w-0 max-w-[320px] flex-1 flex-col gap-2 rounded-md border bg-muted/30"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {column.title}
        </span>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
          {column.tasks.length}
        </Badge>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        <SortableContext items={column.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {column.tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </SortableContext>
        {column.tasks.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground/60">No tasks</p>
        )}
      </div>
    </div>
  );
}
