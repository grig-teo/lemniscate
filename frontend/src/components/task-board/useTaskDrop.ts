import {
  useBacklogTask,
  useMergeTask,
  useReviewTask,
  useStartTask,
  type Task,
} from '@/lib/hooks';
import { columnForStatus } from '@/lib/task-board';
import type { ColumnDef } from '@/lib/task-board';

// Maps a Kanban drop (task → target column) to the existing task-action route.
// No new workflow code: start/review/merge call the pre-existing endpoints;
// only 'backlog' is the new returnToBacklog route. Guards reject transitions
// the backend would also reject (the backend remains the source of truth).
export function useTaskDrop() {
  const startTask = useStartTask();
  const reviewTask = useReviewTask();
  const mergeTask = useMergeTask();
  const backlogTask = useBacklogTask();

  return function drop(task: Task, target: ColumnDef['id']): string | null {
    const source = columnForStatus(task.status);
    if (!source || source === target) return null; // no-op: same column

    switch (target) {
      case 'backlog':
        // Returning in-flight work to the backlog cancels it — confirm first.
        if (!window.confirm(`Return "${task.title}" to the backlog? Any in-flight work is cancelled.`)) {
          return null;
        }
        backlogTask.mutate(task.id);
        return null;
      case 'processes':
        // Only a backlog (pending) task can be started into the pipeline.
        if (source !== 'backlog') {
          return `Cannot start a task that is already ${task.status}.`;
        }
        startTask.mutate(task.id);
        return null;
      case 'review':
        // Review/merge require an open PR (awaiting_review/reviewing_code).
        if (source !== 'review') {
          return 'Open a PR first — review needs an awaiting-review task.';
        }
        reviewTask.mutate(task.id);
        return null;
      case 'done':
        if (source !== 'review') {
          return 'Merge requires a task that is awaiting review.';
        }
        mergeTask.mutate(task.id);
        return null;
      default:
        return null;
    }
  };
}
