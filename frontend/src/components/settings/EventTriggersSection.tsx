import * as React from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  useCreateEventTrigger,
  useDeleteEventTrigger,
  useEventTriggers,
  useRepositories,
  useUpdateEventTrigger,
  type EventTrigger,
  type EventTriggerKind,
  type Repository,
} from '@/lib/hooks';

import { FlagSwitch } from '@/components/repo-tree/FlagSwitch';

const EVENT_KIND_LABELS: Record<EventTriggerKind, string> = {
  ci_failed: 'CI failed',
  issue_opened: 'Issue opened',
};

const EVENT_KIND_DESCRIPTIONS: Record<EventTriggerKind, string> = {
  ci_failed: 'A CI check run / pipeline fails on the default branch.',
  issue_opened: 'A new issue is opened on the repository.',
};

function eventKindLabel(kind: EventTriggerKind): string {
  return EVENT_KIND_LABELS[kind];
}

/** Repository picker: triggers are configured per repository. */
function RepoSelect({
  repos,
  value,
  onChange,
}: {
  repos: Repository[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <FormField label="Repository">
      <Select value={value ?? undefined} onValueChange={onChange}>
        <SelectTrigger className="h-8" aria-label="Trigger repository">
          <SelectValue placeholder="Select a repository" />
        </SelectTrigger>
        <SelectContent>
          {repos.map((repo) => (
            <SelectItem key={repo.id} value={repo.id}>
              <span className="truncate">{repo.fullName}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

/** Create/edit form: event-kind dropdown (create only) + prompt textarea. */
function TriggerForm({
  initial,
  usedKinds,
  pending,
  error,
  onSave,
  onCancel,
}: {
  initial?: EventTrigger;
  usedKinds: EventTriggerKind[];
  pending: boolean;
  error: string | null;
  onSave: (input: { eventKind: EventTriggerKind; taskPrompt: string }) => void;
  onCancel: () => void;
}) {
  const [eventKind, setEventKind] = React.useState<EventTriggerKind>(
    initial?.eventKind ?? availableKinds(usedKinds)[0] ?? 'ci_failed',
  );
  const [taskPrompt, setTaskPrompt] = React.useState(initial?.taskPrompt ?? '');
  const canSave = taskPrompt.trim().length > 0 && !pending;

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      {!initial && (
        <FormField label="When this happens">
          <Select
            value={eventKind}
            onValueChange={(kind) => setEventKind(kind as EventTriggerKind)}
          >
            <SelectTrigger className="h-8" aria-label="Event kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableKinds(usedKinds).map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {eventKindLabel(kind)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {EVENT_KIND_DESCRIPTIONS[eventKind]}
          </span>
        </FormField>
      )}
      <FormField label="Create a task with this prompt">
        <Textarea
          value={taskPrompt}
          onChange={(e) => setTaskPrompt(e.target.value)}
          rows={4}
          aria-label="Trigger task prompt"
          placeholder="e.g. Investigate the failing CI job on the default branch and fix it."
        />
      </FormField>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={!canSave}
          onClick={() => onSave({ eventKind, taskPrompt: taskPrompt.trim() })}
        >
          {initial ? 'Save trigger' : 'Add trigger'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Kinds still available for a new trigger (one per kind per repository). */
function availableKinds(usedKinds: EventTriggerKind[]): EventTriggerKind[] {
  return (Object.keys(EVENT_KIND_LABELS) as EventTriggerKind[]).filter(
    (kind) => !usedKinds.includes(kind),
  );
}

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

function TriggerList({
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

/**
 * Event triggers: when an inbound webhook delivers the chosen event on the
 * selected repository, a task with the configured prompt is created and
 * enqueued automatically.
 */
export function EventTriggersSection() {
  const repos = useRepositories();
  const [chosenRepoId, setChosenRepoId] = React.useState<string | null>(null);
  const repositoryId = chosenRepoId ?? repos.data?.[0]?.id ?? null;
  const triggers = useEventTriggers(repositoryId);
  const createTrigger = useCreateEventTrigger(repositoryId);
  const updateTrigger = useUpdateEventTrigger(repositoryId);
  const [editing, setEditing] = React.useState<EventTrigger | 'new' | null>(null);

  const editingTrigger = editing === 'new' ? undefined : (editing ?? undefined);
  const usedKinds = (triggers.data ?? []).map((trigger) => trigger.eventKind);
  const mutationError = editingTrigger ? updateTrigger.error : createTrigger.error;

  function save(input: { eventKind: EventTriggerKind; taskPrompt: string }) {
    const onSettled = () => setEditing(null);
    if (editingTrigger) {
      updateTrigger.mutate(
        { triggerId: editingTrigger.id, patch: { taskPrompt: input.taskPrompt } },
        { onSuccess: onSettled },
      );
      return;
    }
    createTrigger.mutate(input, { onSuccess: onSettled });
  }

  return (
    <div className="flex flex-col gap-4 border-t py-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Event triggers</h3>
        <p className="text-xs text-muted-foreground">
          Create a task automatically when a webhook event (CI failure, new issue) arrives.
        </p>
      </div>

      <RepoSelect repos={repos.data ?? []} value={repositoryId} onChange={setChosenRepoId} />

      {triggers.isLoading && repositoryId && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {triggers.isError && (
        <p className="text-sm text-destructive">Failed to load: {triggers.error.message}</p>
      )}

      {editing !== null && repositoryId && (
        <TriggerForm
          initial={editingTrigger}
          usedKinds={usedKinds}
          pending={createTrigger.isPending || updateTrigger.isPending}
          error={mutationError?.message ?? null}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {editing === null && triggers.data && repositoryId && (
        <>
          {triggers.data.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No triggers yet — add one to react to CI failures or new issues in real time.
            </p>
          )}
          {triggers.data.length > 0 && (
            <TriggerList
              repositoryId={repositoryId}
              triggers={triggers.data}
              onEdit={setEditing}
            />
          )}
          {availableKinds(usedKinds).length > 0 && (
            <div>
              <Button variant="outline" onClick={() => setEditing('new')}>
                <Plus className="h-4 w-4" />
                Add event trigger
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
