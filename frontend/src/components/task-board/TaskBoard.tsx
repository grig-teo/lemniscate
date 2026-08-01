import { useState } from 'react';
import { Loader2, X } from 'lucide-react';

import {
  DndContext,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';

import { TaskColumn } from '@/components/task-board/TaskColumn';
import { useTaskDrop } from '@/components/task-board/useTaskDrop';
import { Button } from '@/components/ui/button';
import { useRepositories, useTasks } from '@/lib/hooks';
import { inFlightPollInterval } from '@/lib/running-tasks';
import { useWorkspaceSelection } from '@/lib/selection';
import { boardColumns } from '@/lib/task-board';

/**
 * Center-pane Kanban board for one repository. Maps the repository's active
 * tasks into 4 lifecycle columns; cards are dragged between columns to trigger
 * the corresponding workflow action (start / review / merge / return-to-backlog).
 */
export function TaskBoard({ repositoryId }: { repositoryId: string }) {
  const { closeTaskBoard } = useWorkspaceSelection();
  const tasks = useTasks(repositoryId, { refetchInterval: (q) => inFlightPollInterval(q.state.data) });
  const [error, setError] = useState<string | null>(null);
  const drop = useTaskDrop();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const columns = boardColumns(tasks.data ?? []);

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const taskId = String(active.id);
    const task = (tasks.data ?? []).find((t) => t.id === taskId);
    if (!task) return;
    const targetColumn = columns.find((c) => c.tasks.some((t) => t.id === String(over.id)))?.id;
    if (!targetColumn) return;
    const message = drop(task, targetColumn);
    setError(message);
  }

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      <BoardHeader repositoryId={repositoryId} onClose={closeTaskBoard} />
      {error && <p className="px-4 py-1.5 text-xs text-destructive">{error}</p>}
      {tasks.isLoading ? (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading tasks…
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
            {columns.map((column) => (
              <TaskColumn key={column.id} column={column} />
            ))}
          </div>
        </DndContext>
      )}
    </section>
  );
}

function BoardHeader({ repositoryId, onClose }: { repositoryId: string; onClose: () => void }) {
  const { data: repos } = useRepositories();
  const repo = (repos ?? []).find((r) => r.id === repositoryId);
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        Task board — {repo?.fullName ?? repositoryId}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        aria-label="Close task board"
        title="Close task board"
        onClick={onClose}
      >
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
