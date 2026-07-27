import * as React from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDeleteVpsTarget, useVpsTargets, type VpsTarget } from '@/lib/hooks';

import { VpsTargetForm } from '@/components/settings/VpsTargetForm';

function VpsTargetRow({
  target,
  deleting,
  onEdit,
  onDelete,
}: {
  target: VpsTarget;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{target.name}</span>
          <Badge variant="outline">{target.authMethod}</Badge>
        </div>
        <span className="truncate text-xs text-muted-foreground">
          {target.username}@{target.host}:{target.port}
        </span>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} disabled={deleting}>
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>
    </li>
  );
}

/**
 * VPS targets tab: list of saved SSH connection profiles with add/edit/delete.
 * Shows the form inline when adding or editing.
 */
export function VpsTargetsSection() {
  const targets = useVpsTargets();
  const deleteTarget = useDeleteVpsTarget();
  const [editing, setEditing] = React.useState<VpsTarget | 'new' | null>(null);

  function remove(target: VpsTarget) {
    if (window.confirm(`Delete VPS target "${target.name}"? Services using it fall back to Lemniscate.`)) {
      deleteTarget.mutate(target.id);
    }
  }

  if (editing !== null) {
    return (
      <div className="py-2">
        <VpsTargetForm initial={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />
      </div>
    );
  }

  if (targets.isLoading) return <p className="py-2 text-sm text-muted-foreground">Loading…</p>;
  if (targets.isError) {
    return <p className="py-2 text-sm text-destructive">Failed to load: {targets.error.message}</p>;
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      {targets.data && targets.data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No VPS targets yet — add an SSH connection profile to deploy services onto your own server.
        </p>
      )}
      {targets.data && targets.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {targets.data.map((target) => (
            <VpsTargetRow
              key={target.id}
              target={target}
              deleting={deleteTarget.isPending}
              onEdit={() => setEditing(target)}
              onDelete={() => remove(target)}
            />
          ))}
        </ul>
      )}
      {deleteTarget.isError && (
        <p className="text-sm text-destructive">{deleteTarget.error.message}</p>
      )}
      <div>
        <Button variant="outline" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" />
          Add VPS target
        </Button>
      </div>
    </div>
  );
}
