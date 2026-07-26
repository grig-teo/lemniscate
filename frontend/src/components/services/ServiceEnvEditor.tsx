/**
 * Environment-variable editor for one service (extracted from
 * ServiceDetail.tsx per AGENTS.md section 2): values are write-only, keys
 * come from the service row; save merges set/remove via the env endpoint.
 */
import * as React from 'react';
import { X } from 'lucide-react';

import { describeApiError } from '@/lib/api';
import { useSaveServiceEnv } from '@/lib/hooks';
import type { AppService } from '@/lib/services';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function EnvEditor({ service }: { service: AppService }) {
  const saveEnv = useSaveServiceEnv(service.id);
  const [removed, setRemoved] = React.useState<string[]>([]);
  const [added, setAdded] = React.useState<{ key: string; value: string }[]>([]);
  const [newKey, setNewKey] = React.useState('');
  const [newValue, setNewValue] = React.useState('');
  const [message, setMessage] = React.useState<string | null>(null);

  const visibleKeys = service.envKeys.filter((key) => !removed.includes(key));
  const dirty = removed.length > 0 || added.length > 0;

  const save = async () => {
    setMessage(null);
    try {
      await saveEnv.mutateAsync({
        set: Object.fromEntries(added.map((entry) => [entry.key, entry.value])),
        remove: removed,
      });
      setRemoved([]);
      setAdded([]);
      setMessage('Saved — applies from the next deploy.');
    } catch (err) {
      setMessage(describeApiError(err as Error));
    }
  };

  return (
    <div className="grid gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Environment variables
      </span>
      {visibleKeys.length === 0 && added.length === 0 && (
        <p className="text-xs text-muted-foreground/70">No env vars set.</p>
      )}
      {visibleKeys.map((key) => (
        <div key={key} className="flex items-center gap-2 text-sm">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{key}</code>
          <span className="text-xs text-muted-foreground">•••</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-6 w-6"
            aria-label={`Remove ${key}`}
            onClick={() => setRemoved((prev) => [...prev, key])}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
      {added.map((entry) => (
        <div key={entry.key} className="flex items-center gap-2 text-sm">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{entry.key}</code>
          <span className="text-xs text-muted-foreground">(new)</span>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          className="h-8 w-40"
          placeholder="KEY"
          value={newKey}
          onChange={(event) => setNewKey(event.target.value)}
        />
        <Input
          className="h-8 flex-1"
          placeholder="value"
          type="password"
          value={newValue}
          onChange={(event) => setNewValue(event.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newKey)}
          onClick={() => {
            setAdded((prev) => [...prev.filter((e) => e.key !== newKey), { key: newKey, value: newValue }]);
            setNewKey('');
            setNewValue('');
          }}
        >
          Add
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!dirty || saveEnv.isPending} onClick={() => void save()}>
          {saveEnv.isPending ? 'Saving…' : 'Save env'}
        </Button>
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
      </div>
    </div>
  );
}
