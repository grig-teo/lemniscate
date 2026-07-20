import type { Repository } from '@/lib/hooks';

export interface ConnectionGroup {
  connectionId: string;
  provider: string;
  username: string;
  repos: Repository[];
}

/** Group repositories by their git-host connection, groups sorted by provider. */
export function groupByConnection(repos: Repository[]): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>();
  for (const repo of repos) {
    const group =
      groups.get(repo.connectionId) ?? {
        connectionId: repo.connectionId,
        provider: repo.connection.provider,
        username: repo.connection.username,
        repos: [],
      };
    group.repos.push(repo);
    groups.set(repo.connectionId, group);
  }
  return [...groups.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}
