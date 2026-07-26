/**
 * Propagates live (SSE) task status changes into the TanStack Query caches
 * that feed the task lists (repo tree, landing "Running processes") and the
 * task detail view. The console's SSE stream is the live channel; without
 * this sync the lists kept showing the stale 'queued' status from the last
 * invalidation refetch while the console already showed 'running'.
 */
import type { QueryClient } from '@tanstack/react-query';

import type { Task } from '@/lib/hooks';

function withStatus(task: Task, taskId: string, status: string): Task {
  return task.id === taskId ? { ...task, status } : task;
}

/** Write a live status into every cached task list and the detail cache. */
export function applyTaskStatusToCaches(
  queryClient: QueryClient,
  taskId: string,
  status: string,
): void {
  // Prefix match covers ['tasks', repositoryId|null, 'active'|'archived'].
  queryClient.setQueriesData<Task[]>({ queryKey: ['tasks'] }, (old) =>
    old?.map((task) => withStatus(task, taskId, status)),
  );
  queryClient.setQueryData<Task>(['task', taskId], (old) =>
    old ? { ...old, status } : old,
  );
}
