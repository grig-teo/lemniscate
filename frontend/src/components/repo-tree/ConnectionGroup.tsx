import { useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';

import type { ConnectionGroup as ConnectionGroupData } from '@/lib/group-repos';
import { readPersisted, writePersisted } from '@/lib/persist';
import { providerLabel, ProviderIcon } from '@/lib/providers';
import { cn, hoverReveal } from '@/lib/utils';
import { Button } from '@/components/ui/button';

import { RepoRow } from '@/components/repo-tree/RepoRow';

const COLLAPSED_STORAGE_KEY = 'lemniscate.collapsed-connections';

function readCollapsed(connectionId: string): boolean {
  return !!readPersisted<Record<string, boolean>>(COLLAPSED_STORAGE_KEY, {})[connectionId];
}

function writeCollapsed(connectionId: string, collapsed: boolean): void {
  const map = readPersisted<Record<string, boolean>>(COLLAPSED_STORAGE_KEY, {});
  writePersisted(COLLAPSED_STORAGE_KEY, { ...map, [connectionId]: collapsed });
}

/** Collapsed state of one connection group, persisted per connectionId. */
function usePersistedCollapsed(connectionId: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(connectionId));
  const toggle = () =>
    setCollapsed((prev) => {
      writeCollapsed(connectionId, !prev);
      return !prev;
    });
  return [collapsed, toggle];
}

/**
 * One git-host connection in the sidebar: provider icon + username header
 * with a Sync button, then the connection's repositories.
 */
export function ConnectionGroup({
  group,
  syncing,
  syncError,
  onSync,
  expanded,
  onToggleRepo,
}: {
  group: ConnectionGroupData;
  syncing: boolean;
  /** Human-readable failure of the last Sync click for this connection. */
  syncError: string | null;
  onSync: (connectionId: string) => void;
  expanded: Record<string, boolean>;
  onToggleRepo: (repoId: string) => void;
}) {
  const label = providerLabel(group.provider, 'capitalized');
  const [collapsed, toggleCollapsed] = usePersistedCollapsed(group.connectionId);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="border-b last:border-b-0">
      <div className="group flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={!collapsed}
          aria-label={`${label} @${group.username}`}
        >
          <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <ProviderIcon
            provider={group.provider}
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
          <span className="truncate text-xs font-semibold">{label}</span>
          <span className={cn('truncate text-xs text-muted-foreground', hoverReveal)}>
            @{group.username}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className={cn('ml-auto h-6 w-6 shrink-0', hoverReveal)}
          aria-label={`Sync ${label} repositories`}
          disabled={syncing}
          onClick={(event) => {
            event.stopPropagation();
            onSync(group.connectionId);
          }}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
        </Button>
      </div>

      {/* Transient toasts also report this failure; keep an inline copy next
          to the Sync button so it survives after the toast disappears. */}
      {syncError && (
        <p role="alert" className="px-3 pb-2 text-[11px] text-destructive">
          Sync failed: {syncError}
        </p>
      )}

      {!collapsed &&
        group.repos.map((repo) => (
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
