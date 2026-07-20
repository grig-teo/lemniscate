import * as React from 'react';
import { Unplug } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConnectProviderButtons } from '@/components/ConnectProviderButtons';
import { GitVerseConnectDialog } from '@/components/GitVerseConnectDialog';
import { useConnections, useDeleteConnection, type Connection } from '@/lib/hooks';
import { providerLabel, ProviderIcon } from '@/lib/providers';

function ConnectionRow({
  connection,
  deleting,
  onDisconnect,
}: {
  connection: Connection;
  deleting: boolean;
  onDisconnect: (connection: Connection) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderIcon provider={connection.provider} className="h-4 w-4 shrink-0" />
        <span className="truncate text-sm font-medium">{connection.username}</span>
        <Badge variant="outline">{providerLabel(connection.provider)}</Badge>
        {connection.baseUrl && (
          <span className="truncate text-xs text-muted-foreground">{connection.baseUrl}</span>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onDisconnect(connection)}
        disabled={deleting}
      >
        <Unplug className="h-4 w-4" />
        Disconnect
      </Button>
    </li>
  );
}

/**
 * Git connections tab: connected accounts, OAuth connect buttons for
 * GitHub/GitLab, and a token dialog for GitVerse.
 */
export function ConnectionsSection() {
  const connections = useConnections();
  const deleteConnection = useDeleteConnection();
  const [gitverseOpen, setGitverseOpen] = React.useState(false);

  function disconnect(connection: Connection) {
    const label = providerLabel(connection.provider);
    if (window.confirm(`Disconnect ${label} account "${connection.username}"?`)) {
      deleteConnection.mutate(connection.id);
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      {connections.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {connections.isError && (
        <p className="text-sm text-destructive">Failed to load connections: {connections.error.message}</p>
      )}

      {connections.data && connections.data.length === 0 && (
        <p className="text-sm text-muted-foreground">No git hosts connected yet.</p>
      )}

      <ul className="flex flex-col gap-2">
        {connections.data?.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            deleting={deleteConnection.isPending}
            onDisconnect={disconnect}
          />
        ))}
      </ul>

      {deleteConnection.isError && (
        <p className="text-sm text-destructive">{deleteConnection.error.message}</p>
      )}

      <div className="flex flex-wrap gap-2 border-t pt-4">
        <ConnectProviderButtons onGitverse={() => setGitverseOpen(true)} />
      </div>

      <GitVerseConnectDialog open={gitverseOpen} onOpenChange={setGitverseOpen} />
    </div>
  );
}
