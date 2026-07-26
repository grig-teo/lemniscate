import * as React from 'react';
import { GitBranch, Loader2, Plus } from 'lucide-react';

import { useRepositories, useSyncConnection } from '@/lib/hooks';
import { describeApiError } from '@/lib/api';
import { groupByConnection, type ConnectionGroup as ConnectionGroupData } from '@/lib/group-repos';
import { isSectionCollapsed, useSidebarSections } from '@/lib/sidebar-sections';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

import { ConnectionGroup } from '@/components/repo-tree/ConnectionGroup';
import { CreateRepoDialog } from '@/components/repo-tree/CreateRepoDialog';
import { useExpandedMap } from '@/components/repo-tree/useExpandedMap';
import { DeviceBar } from '@/components/devices/DeviceBar';
import { ServicesSection } from '@/components/services/ServicesSection';
import { SectionHeader } from '@/components/sidebar/SectionHeader';

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
  syncError,
  onSync,
  expanded,
  onToggleRepo,
}: {
  reposQuery: ReposQuery;
  groups: ConnectionGroupData[];
  syncing: boolean;
  syncError: { connectionId: string; message: string } | null;
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
          syncError={syncError?.connectionId === group.connectionId ? syncError.message : null}
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
 * each repo expandable to show its tasks; per-repo toggles (autoCreatePr,
 * autoReviewPr, autoMergePr); per-group Sync. The header + button opens the
 * create-repository dialog. New prompt tasks are started from the + button
 * in the console pane (opens the composer dialog). The DeviceBar strip is
 * pinned below the scrollable list, always visible.
 */
export function RepoTree({ width }: { width: number }) {
  const reposQuery = useRepositories();
  const syncConnection = useSyncConnection();
  const { expanded, toggle } = useExpandedMap();
  const { collapsed: collapsedSections, toggle: toggleSection } = useSidebarSections();
  const [createOpen, setCreateOpen] = React.useState(false);

  const groups = React.useMemo(() => groupByConnection(reposQuery.data ?? []), [reposQuery.data]);

  const createButton = (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      aria-label="Create repository"
      onClick={() => setCreateOpen(true)}
    >
      <Plus className="h-3.5 w-3.5" />
    </Button>
  );

  return (
    <aside className="flex h-full shrink-0 flex-col border-r bg-card" style={{ width }}>
      <div className="border-b">
        <SectionHeader
          label="Repositories"
          collapsed={isSectionCollapsed(collapsedSections, 'repositories')}
          onToggle={() => toggleSection('repositories')}
          action={createButton}
        />
      </div>

      {/* Rows are bounded to the sidebar width: titles truncate with an
          ellipsis while badges/action icons stay pinned to the resize edge. */}
      {!isSectionCollapsed(collapsedSections, 'repositories') && (
        <ScrollArea className="flex-1">
          <RepoTreeBody
            reposQuery={reposQuery}
            groups={groups}
            syncing={syncConnection.isPending}
            syncError={
              syncConnection.isError
                ? {
                    connectionId: syncConnection.variables as string,
                    message: describeApiError(syncConnection.error),
                  }
                : null
            }
            onSync={(connectionId) => syncConnection.mutate(connectionId)}
            expanded={expanded}
            onToggleRepo={toggle}
          />
        </ScrollArea>
      )}
      {/* When the repo list is hidden, this spacer takes over its flex-1
          role so the device bar stays pinned to the bottom. */}
      {isSectionCollapsed(collapsedSections, 'repositories') && <div className="flex-1" />}

      {/* Services (deployed apps): fixed block between the scrolling repo
          list and the pinned device bar. */}
      <ServicesSection
        collapsed={isSectionCollapsed(collapsedSections, 'services')}
        onToggle={() => toggleSection('services')}
      />

      {/* Paired devices: a constant, non-scrolling strip pinned to the
          bottom of the sidebar while the repo list scrolls above it. */}
      <DeviceBar
        collapsed={isSectionCollapsed(collapsedSections, 'devices')}
        onToggle={() => toggleSection('devices')}
      />

      <CreateRepoDialog open={createOpen} onOpenChange={setCreateOpen} />
    </aside>
  );
}
