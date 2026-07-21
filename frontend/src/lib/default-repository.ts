import type { Repository } from '@/lib/hooks';
import type { SelectedTask } from '@/lib/selection';

function firstListedId(repositories: Repository[], id: string | null | undefined): string | null {
  if (id && repositories.some((repo) => repo.id === id)) return id;
  return null;
}

/**
 * Default repository for the task composer: the selected task's repository
 * when it is still in the list, then the selected repository (repo tree),
 * otherwise the first repository ('' if none).
 */
export function defaultRepositoryId(
  repositories: Repository[],
  selectedTask: SelectedTask | null,
  selectedRepositoryId?: string | null,
): string {
  const fromTask = firstListedId(repositories, selectedTask?.repositoryId);
  if (fromTask) return fromTask;
  const fromSelection = firstListedId(repositories, selectedRepositoryId);
  if (fromSelection) return fromSelection;
  return repositories[0]?.id ?? '';
}
