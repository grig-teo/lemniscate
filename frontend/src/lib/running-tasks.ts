import type { Repository, Task } from '@/lib/hooks';

/** Statuses shown in the landing "Running processes" section. */
const RUNNING_STATUSES: ReadonlySet<string> = new Set(['queued', 'running']);

export interface RepositoryTaskGroup {
  repositoryName: string;
  tasks: Task[];
}

/** Tasks currently in flight (queued or running), order preserved. */
export function selectRunningTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => RUNNING_STATUSES.has(task.status));
}

/**
 * Group tasks under their repository display name, preserving task order.
 * Tasks whose repository is not in the list fall back to "Unknown repository".
 */
export function groupTasksByRepository(
  tasks: Task[],
  repositories: Repository[],
): RepositoryTaskGroup[] {
  const nameById = new Map(repositories.map((repo) => [repo.id, repo.name]));
  const groups = new Map<string, RepositoryTaskGroup>();
  for (const task of tasks) {
    const key = nameById.has(task.repositoryId) ? task.repositoryId : '';
    const group = groups.get(key) ?? {
      repositoryName: nameById.get(task.repositoryId) ?? 'Unknown repository',
      tasks: [],
    };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()];
}
