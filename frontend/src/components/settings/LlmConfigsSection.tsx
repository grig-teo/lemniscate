import * as React from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useDeleteLlmConfig,
  useLlmConfigs,
  useLlmProviderPresets,
  type LlmConfig,
  type LlmProviderPreset,
} from '@/lib/hooks';

import { LlmConfigForm } from '@/components/settings/LlmConfigForm';
import { XaiOauthConnect } from '@/components/settings/XaiOauthConnect';

function EnabledBadge({ enabled }: { enabled: boolean }) {
  if (enabled) return <Badge variant="outline">enabled</Badge>;
  return <Badge variant="destructive">disabled</Badge>;
}

function AuthBadge({ config }: { config: LlmConfig }) {
  if (config.authType === 'oauth') {
    return <Badge variant="secondary">xAI OAuth</Badge>;
  }
  return null;
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
          <AuthBadge config={config} />
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

/** What the inline form is editing: a saved config, a preset add-flow, or a custom endpoint. */
type Editing = LlmConfig | LlmProviderPreset | 'custom';

function isPreset(editing: Editing): editing is LlmProviderPreset {
  return typeof editing !== 'string' && 'pattern' in editing;
}

/**
 * The "Add provider" buttons: one per registry preset (OpenAI, Anthropic,
 * z.ai, Kimi/Moonshot, Grok/xAI) plus a custom endpoint. Clicking one opens
 * the config form pre-filled from the preset — only the API key is left to
 * type. Preset-add for an existing provider is allowed (multiple keys/models
 * per provider are normal); the list above shows what is already configured.
 */
function AddProviderButtons({ onAdd }: { onAdd: (editing: Editing) => void }) {
  const presets = useLlmProviderPresets();
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Add provider
      </span>
      <div className="flex flex-wrap gap-2">
        {presets.data?.map((preset) => (
          <Button key={preset.id} variant="outline" size="sm" onClick={() => onAdd(preset)}>
            <Plus className="h-4 w-4" />
            Add {preset.label}
          </Button>
        ))}
        <Button variant="ghost" size="sm" onClick={() => onAdd('custom')}>
          Custom endpoint
        </Button>
      </div>
      {presets.isError && (
        <p className="text-sm text-destructive">
          Failed to load provider presets: {presets.error.message}
        </p>
      )}
    </div>
  );
}

/**
 * LLM configs tab: list of saved configs with add/edit/delete.
 * Shows the form inline when adding or editing. Includes Connect with xAI
 * (OAuth device code) above the API-key provider buttons.
 */
export function LlmConfigsSection() {
  const configs = useLlmConfigs();
  const deleteConfig = useDeleteLlmConfig();
  const [editing, setEditing] = React.useState<Editing | null>(null);
  const [oauthKey, setOauthKey] = React.useState(0);

  function remove(config: LlmConfig) {
    if (window.confirm(`Delete LLM config "${config.name}"?`)) {
      deleteConfig.mutate(config.id);
    }
  }

  if (editing !== null) {
    return (
      <div className="py-2">
        <LlmConfigForm
          initial={editing !== 'custom' && !isPreset(editing) ? editing : undefined}
          preset={isPreset(editing) ? editing : undefined}
          onDone={() => setEditing(null)}
        />
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

      <XaiOauthConnect key={oauthKey} onDone={() => setOauthKey((n) => n + 1)} />

      <AddProviderButtons onAdd={setEditing} />
    </div>
  );
}
