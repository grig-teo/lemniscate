import * as React from 'react';
import { GitBranch, Loader2 } from 'lucide-react';

import { useRepositories, useSyncConnection } from '@/lib/hooks';
import { groupByConnection, type ConnectionGroup as ConnectionGroupData } from '@/lib/group-repos';
import { ScrollArea } from '@/components/ui/scroll-area';

import { ConnectionGroup } from '@/components/repo-tree/ConnectionGroup';
import { useExpandedMap } from '@/components/repo-tree/useExpandedMap';

type ReposQuery = ReturnType<typeof useRepositories>;

function LoadingState() {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      Loading…
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <GitBranch className="h-8 w-8 text-muted-foreground/50" aria-hidden />
      <p className="text-sm text-muted-foreground">No repositories connected yet.</p>
      <p className="text-xs text-muted-foreground/70">
        Connect a git host in settings, then pick repositories to let the agent work on.
      </p>
    </div>
  );
}

function RepoTreeBody({
  reposQuery,
  groups,
  syncing,
  onSync,
  expanded,
  onToggleRepo,
}: {
  reposQuery: ReposQuery;
  groups: ConnectionGroupData[];
  syncing: boolean;
  onSync: (connectionId: string) => void;
  expanded: Record<string, boolean>;
  onToggleRepo: (repoId: string) => void;
}) {
  if (reposQuery.isLoading) return <LoadingState />;
  if (reposQuery.isError) {
    return (
      <p className="px-4 py-10 text-center text-sm text-destructive">
        Failed to load repositories: {reposQuery.error.message}
      </p>
    );
  }
  if (groups.length === 0) return <EmptyState />;
  return (
    <>
      {groups.map((group) => (
        <ConnectionGroup
          key={group.connectionId}
          group={group}
          syncing={syncing}
          onSync={onSync}
          expanded={expanded}
          onToggleRepo={onToggleRepo}
        />
      ))}
    </>
  );
}

/**
 * LEFT pane — repository sidebar.
 *
 * Repositories grouped by git-host connection (provider icon + username),
 * each repo expandable to show its tasks; per-repo toggles (autoPropose,
 * autoCreatePr, autoReviewPr, autoMergePr); per-group Sync. New prompt
 * tasks are started from the + button in the console pane (opens the
 * composer dialog).
 */
export function RepoTree({ width }: { width: number }) {
  const reposQuery = useRepositories();
  const syncConnection = useSyncConnection();
  const { expanded, toggle } = useExpandedMap();

  const groups = React.useMemo(() => groupByConnection(reposQuery.data ?? []), [reposQuery.data]);

  return (
    <aside className="flex h-full shrink-0 flex-col border-r bg-card" style={{ width }}>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Repositories
        </span>
      </div>

      <ScrollArea className="flex-1">
        <RepoTreeBody
          reposQuery={reposQuery}
          groups={groups}
          syncing={syncConnection.isPending}
          onSync={(connectionId) => syncConnection.mutate(connectionId)}
          expanded={expanded}
          onToggleRepo={toggle}
        />
      </ScrollArea>
    </aside>
  );
}
