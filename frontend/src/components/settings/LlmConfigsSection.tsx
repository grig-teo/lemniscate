import * as React from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDeleteLlmConfig, useLlmConfigs, type LlmConfig } from '@/lib/hooks';

import { LlmConfigForm } from '@/components/settings/LlmConfigForm';

function EnabledBadge({ enabled }: { enabled: boolean }) {
  if (enabled) return <Badge variant="outline">enabled</Badge>;
  return <Badge variant="destructive">disabled</Badge>;
}

function LlmConfigRow({
  config,
  deleting,
  onEdit,
  onDelete,
}: {
  config: LlmConfig;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{config.name}</span>
          {config.isDefault && <Badge variant="secondary">default</Badge>}
          <EnabledBadge enabled={config.enabled} />
        </div>
        <span className="truncate text-xs text-muted-foreground">
          {config.model} · {config.baseUrl}
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

function LlmConfigList({
  configs,
  deleteConfig,
  onEdit,
  onDelete,
}: {
  configs: ReturnType<typeof useLlmConfigs>;
  deleteConfig: ReturnType<typeof useDeleteLlmConfig>;
  onEdit: (config: LlmConfig) => void;
  onDelete: (config: LlmConfig) => void;
}) {
  if (configs.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (configs.isError) {
    return (
      <p className="text-sm text-destructive">Failed to load configs: {configs.error.message}</p>
    );
  }
  return (
    <>
      {configs.data && configs.data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No LLM configs yet — add one to let the agent call your model.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {configs.data?.map((config) => (
          <LlmConfigRow
            key={config.id}
            config={config}
            deleting={deleteConfig.isPending}
            onEdit={() => onEdit(config)}
            onDelete={() => onDelete(config)}
          />
        ))}
      </ul>

      {deleteConfig.isError && (
        <p className="text-sm text-destructive">{deleteConfig.error.message}</p>
      )}
    </>
  );
}

/**
 * LLM configs tab: list of saved configs with add/edit/delete.
 * Shows the form inline when adding or editing.
 */
export function LlmConfigsSection() {
  const configs = useLlmConfigs();
  const deleteConfig = useDeleteLlmConfig();
  const [editing, setEditing] = React.useState<LlmConfig | 'new' | null>(null);

  function remove(config: LlmConfig) {
    if (window.confirm(`Delete LLM config "${config.name}"?`)) {
      deleteConfig.mutate(config.id);
    }
  }

  if (editing !== null) {
    return (
      <div className="py-2">
        <LlmConfigForm initial={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <LlmConfigList
        configs={configs}
        deleteConfig={deleteConfig}
        onEdit={setEditing}
        onDelete={remove}
      />

      <div>
        <Button variant="outline" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" />
          Add config
        </Button>
      </div>
    </div>
  );
}
