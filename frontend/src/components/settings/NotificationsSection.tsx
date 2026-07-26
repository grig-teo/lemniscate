import * as React from 'react';
import { Plus, Send, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  useDeleteNotificationChannel,
  useNotificationChannels,
  useTestNotificationChannel,
  useUpdateNotificationChannel,
} from '@/lib/hooks';
import {
  channelEventLabel,
  type NotificationChannel,
  type NotificationDelivery,
} from '@/lib/notification-channels';

import { NotificationChannelForm } from '@/components/settings/NotificationChannelForm';
import { BrowserNotificationsSection } from '@/components/settings/BrowserNotificationsSection';

function deliveryVariant(status: string): 'secondary' | 'outline' | 'destructive' {
  if (status === 'delivered') return 'secondary';
  if (status === 'failed') return 'destructive';
  return 'outline';
}

function LastDeliveryBadge({ delivery }: { delivery: NotificationDelivery | null }) {
  if (!delivery) return null;
  return (
    <Badge variant={deliveryVariant(delivery.status)} title={delivery.lastError ?? undefined}>
      last: {delivery.status}
      {delivery.lastStatusCode !== null ? ` ${delivery.lastStatusCode}` : ''}
    </Badge>
  );
}

function ChannelRow({
  channel,
  deleting,
  onToggleEnabled,
  onDelete,
}: {
  channel: NotificationChannel;
  deleting: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const test = useTestNotificationChannel();
  return (
    <li className="flex flex-col gap-2 rounded-md border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{channel.target}</span>
            <Badge variant="outline">{channel.channel}</Badge>
            <LastDeliveryBadge delivery={channel.lastDelivery} />
          </div>
          <span className="truncate text-xs text-muted-foreground">
            {channel.events.map(channelEventLabel).join(' · ')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={channel.enabled}
            onCheckedChange={onToggleEnabled}
            aria-label={channel.enabled ? 'Disable channel' : 'Enable channel'}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => test.mutate(channel.id)}
            disabled={test.isPending}
          >
            <Send className="h-4 w-4" />
            {test.isPending ? 'Testing…' : 'Test'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} disabled={deleting}>
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>
      {test.data && !test.data.ok && (
        <p className="text-xs text-destructive">
          Test failed: {test.data.error ?? 'unknown error'}
        </p>
      )}
      {test.data?.ok && (
        <p className="text-xs text-emerald-500">
          Test delivered{test.data.statusCode !== null ? ` (HTTP ${test.data.statusCode})` : ''}
        </p>
      )}
    </li>
  );
}

/**
 * Notifications tab: outbound channels (signed webhooks, email) subscribed
 * to agent events. Add/test/enable/disable/delete; the last delivery status
 * comes from the backend's NotificationDelivery audit log.
 */
export function NotificationsSection() {
  const channels = useNotificationChannels();
  const deleteChannel = useDeleteNotificationChannel();
  const updateChannel = useUpdateNotificationChannel();
  const [adding, setAdding] = React.useState(false);

  function remove(channel: NotificationChannel) {
    if (window.confirm(`Delete ${channel.channel} channel "${channel.target}"?`)) {
      deleteChannel.mutate(channel.id);
    }
  }

  if (adding) {
    return (
      <div className="py-2">
        <NotificationChannelForm onDone={() => setAdding(false)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <BrowserNotificationsSection />

      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Outbound channels</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {channels.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {channels.isError && (
        <p className="text-sm text-destructive">
          Failed to load channels: {channels.error.message}
        </p>
      )}
      {channels.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No outbound channels yet — add a webhook or email to be notified when tasks finish, PRs
          open, or scheduled jobs fail.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {channels.data?.map((channel) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            deleting={deleteChannel.isPending}
            onToggleEnabled={(enabled) => updateChannel.mutate({ id: channel.id, patch: { enabled } })}
            onDelete={() => remove(channel)}
          />
        ))}
      </ul>

      {deleteChannel.isError && (
        <p className="text-sm text-destructive">{deleteChannel.error.message}</p>
      )}
      {updateChannel.isError && (
        <p className="text-sm text-destructive">{updateChannel.error.message}</p>
      )}

      <div>
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" />
          Add channel
        </Button>
      </div>
    </div>
  );
}
