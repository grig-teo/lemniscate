import { RefreshCw } from 'lucide-react';

import type { ConnectionGroup as ConnectionGroupData } from '@/lib/group-repos';
import { providerLabel, ProviderIcon } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

import { RepoRow } from '@/components/repo-tree/RepoRow';

/**
 * One git-host connection in the sidebar: provider icon + username header
 * with a Sync button, then the connection's repositories.
 */
export function ConnectionGroup({
  group,
  syncing,
  onSync,
  expanded,
  onToggleRepo,
}: {
  group: ConnectionGroupData;
  syncing: boolean;
  onSync: (connectionId: string) => void;
  expanded: Record<string, boolean>;
  onToggleRepo: (repoId: string) => void;
}) {
  const label = providerLabel(group.provider, 'capitalized');
  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2">
        <ProviderIcon provider={group.provider} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-semibold">{label}</span>
        <span className="truncate text-xs text-muted-foreground">@{group.username}</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6 shrink-0"
          aria-label={`Sync ${label} repositories`}
          disabled={syncing}
          onClick={() => onSync(group.connectionId)}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
        </Button>
      </div>

      {group.repos.map((repo) => (
        <RepoRow
          key={repo.id}
          repo={repo}
          expanded={!!expanded[repo.id]}
          onToggle={() => onToggleRepo(repo.id)}
        />
      ))}
    </div>
  );
}
