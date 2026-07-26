import * as React from 'react';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { describeApiError } from '@/lib/api';
import { useCreateNotificationChannel } from '@/lib/hooks';
import {
  NOTIFICATION_CHANNEL_EVENTS,
  channelTargetError,
  toggleEvent,
  type NotificationChannel,
  type NotificationChannelKind,
} from '@/lib/notification-channels';

function EventCheckboxes({
  events,
  onToggle,
}: {
  events: string[];
  onToggle: (kind: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {NOTIFICATION_CHANNEL_EVENTS.map((event) => (
        <label key={event.kind} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={events.includes(event.kind)}
            onChange={() => onToggle(event.kind)}
          />
          {event.label}
        </label>
      ))}
    </div>
  );
}

/** One-time secret shown right after a webhook channel is created. */
function WebhookSecretNote({ secret }: { secret: string }) {
  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs">
      <p className="font-medium">Channel created — webhook signing secret:</p>
      <p className="mt-1 break-all font-mono">{secret}</p>
      <p className="mt-1 text-muted-foreground">
        Verify deliveries with the `x-lemniscate-signature: sha256=…` header (HMAC-SHA256 of the
        raw body with this secret).
      </p>
    </div>
  );
}

/**
 * Add form for one outbound notification channel (webhook or email). After a
 * webhook channel is created its HMAC secret is shown once so the user can
 * wire it into their bridge.
 */
export function NotificationChannelForm({ onDone }: { onDone: () => void }) {
  const create = useCreateNotificationChannel();
  const [channel, setChannel] = React.useState<NotificationChannelKind>('webhook');
  const [target, setTarget] = React.useState('');
  const [events, setEvents] = React.useState<string[]>(
    NOTIFICATION_CHANNEL_EVENTS.map((event) => event.kind),
  );
  const [created, setCreated] = React.useState<NotificationChannel | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const targetError = channelTargetError(channel, target.trim());
    if (targetError) {
      setFormError(targetError);
      return;
    }
    if (events.length === 0) {
      setFormError('Subscribe to at least one event');
      return;
    }
    setFormError(null);
    create.mutate(
      { channel, target: target.trim(), events },
      { onSuccess: (channel_) => setCreated(channel_) },
    );
  }

  if (created) {
    return (
      <div className="flex flex-col gap-4">
        {created.webhookSecret ? (
          <WebhookSecretNote secret={created.webhookSecret} />
        ) : (
          <p className="text-sm">Email channel created.</p>
        )}
        <div>
          <Button variant="outline" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormField label="Channel type">
        <Select
          value={channel}
          onValueChange={(value) => setChannel(value as NotificationChannelKind)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="webhook">Webhook (HMAC-signed POST)</SelectItem>
            <SelectItem value="email">Email (via SMTP env config)</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
      <FormField label={channel === 'email' ? 'Email address' : 'Webhook URL'}>
        <Input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={channel === 'email' ? 'you@example.com' : 'https://bridge.example.com/hook'}
        />
      </FormField>
      <FormField label="Events">
        <EventCheckboxes events={events} onToggle={(kind) => setEvents(toggleEvent(events, kind))} />
      </FormField>

      {formError && <p className="text-sm text-destructive">{formError}</p>}
      {create.isError && <p className="text-sm text-destructive">{describeApiError(create.error)}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add channel'}
        </Button>
      </div>
    </form>
  );
}
