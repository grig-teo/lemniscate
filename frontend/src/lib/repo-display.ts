import type { Repository } from '@/lib/hooks';

type RepoDisplayInfo = Pick<Repository, 'name' | 'fullName' | 'connection'>;

/**
 * Repo label for compact lists: `owner / name` when the repo owner differs
 * from the connection's username (e.g. an org repo), otherwise just `name`.
 */
export function repoDisplayName(repo: RepoDisplayInfo): string {
  const owner = repo.fullName.split('/')[0];
  if (!owner || owner === repo.connection.username) return repo.name;
  return `${owner} / ${repo.name}`;
}
