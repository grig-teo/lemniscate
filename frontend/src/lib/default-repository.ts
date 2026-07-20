import type { Repository } from '@/lib/hooks';
import type { SelectedTask } from '@/lib/selection';

/**
 * Default repository for the task composer: the selected task's repository
 * when it is still in the list, otherwise the first repository ('' if none).
 */
export function defaultRepositoryId(
  repositories: Repository[],
  selectedTask: SelectedTask | null,
): string {
  const taskRepoId = selectedTask?.repositoryId;
  if (taskRepoId && repositories.some((repo) => repo.id === taskRepoId)) {
    return taskRepoId;
  }
  return repositories[0]?.id ?? '';
}
