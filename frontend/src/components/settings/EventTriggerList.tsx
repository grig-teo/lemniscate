import { Pencil, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useDeleteEventTrigger,
  useUpdateEventTrigger,
  type EventTrigger,
} from '@/lib/hooks';

import { FlagSwitch } from '@/components/repo-tree/FlagSwitch';

import { eventKindLabel } from './event-triggers-utils';

function TriggerRow({
  trigger,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  trigger: EventTrigger;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{eventKindLabel(trigger.eventKind)}</Badge>
          <FlagSwitch
            label="enabled"
            ariaLabel={`Enable ${eventKindLabel(trigger.eventKind)} trigger`}
            checked={trigger.enabled}
            disabled={busy}
            onChange={onToggle}
          />
        </div>
        <span className="line-clamp-2 text-xs text-muted-foreground">{trigger.taskPrompt}</span>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy}>
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>
    </li>
  );
}

export function TriggerList({
  repositoryId,
  triggers,
  onEdit,
}: {
  repositoryId: string;
  triggers: EventTrigger[];
  onEdit: (trigger: EventTrigger) => void;
}) {
  const updateTrigger = useUpdateEventTrigger(repositoryId);
  const deleteTrigger = useDeleteEventTrigger(repositoryId);
  const busy = updateTrigger.isPending || deleteTrigger.isPending;

  function remove(trigger: EventTrigger) {
    if (window.confirm(`Delete the "${eventKindLabel(trigger.eventKind)}" trigger?`)) {
      deleteTrigger.mutate(trigger.id);
    }
  }

  return (
    <>
      <ul className="flex flex-col gap-2">
        {triggers.map((trigger) => (
          <TriggerRow
            key={trigger.id}
            trigger={trigger}
            busy={busy}
            onToggle={(enabled) => updateTrigger.mutate({ triggerId: trigger.id, patch: { enabled } })}
            onEdit={() => onEdit(trigger)}
            onDelete={() => remove(trigger)}
          />
        ))}
      </ul>
      {(updateTrigger.isError || deleteTrigger.isError) && (
        <p className="text-sm text-destructive">
          {updateTrigger.error?.message ?? deleteTrigger.error?.message}
        </p>
      )}
    </>
  );
}
