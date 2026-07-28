/**
 * Outbound notification channels (Settings → Notifications): per-user
 * webhook/email targets subscribed to agent event kinds, delivered by the
 * backend's BullMQ-retried, HMAC-signed dispatcher. API wrappers plus the
 * pure helpers driving the form (unit-tested below in
 * notification-channels.test.ts).
 */
import { api } from '@/lib/api';

export type NotificationChannelKind = 'webhook' | 'email';

export type NotificationDelivery = {
  id: string;
  event: string;
  status: 'queued' | 'delivered' | 'failed' | 'skipped' | (string & {});
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
};

export type NotificationChannel = {
  id: string;
  channel: NotificationChannelKind;
  target: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  webhookSecret: string | null;
  lastDelivery: NotificationDelivery | null;
};

export type NotificationChannelPayload = {
  channel: NotificationChannelKind;
  target: string;
  events: string[];
  enabled?: boolean;
};

export type NotificationChannelPatch = Partial<
  Pick<NotificationChannel, 'target' | 'events' | 'enabled'>
>;

export type ChannelTestResult = {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
};

export function fetchNotificationChannels(): Promise<NotificationChannel[]> {
  return api
    .get<{ channels: NotificationChannel[] }>('/api/notifications/channels')
    .then((res) => res.channels);
}

export function createNotificationChannel(
  payload: NotificationChannelPayload,
): Promise<NotificationChannel> {
  return api
    .post<{ channel: NotificationChannel }>('/api/notifications/channels', payload)
    .then((res) => res.channel);
}

export function updateNotificationChannel(
  id: string,
  patch: NotificationChannelPatch,
): Promise<NotificationChannel> {
  return api
    .patch<{ channel: NotificationChannel }>(`/api/notifications/channels/${id}`, patch)
    .then((res) => res.channel);
}

export function deleteNotificationChannel(id: string): Promise<{ deleted: number }> {
  return api.del<{ deleted: number }>(`/api/notifications/channels/${id}`);
}

export function testNotificationChannel(id: string): Promise<ChannelTestResult> {
  return api.post<ChannelTestResult>(`/api/notifications/channels/${id}/test`);
}

// ---------------------------------------------------------------------------
// Pure form helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Event kinds a channel can subscribe to, in display order. */
export const NOTIFICATION_CHANNEL_EVENTS: ReadonlyArray<{ kind: string; label: string }> = [
  { kind: 'pr_opened', label: 'PR opened' },
  { kind: 'pr_merged', label: 'PR merged' },
  { kind: 'pr_closed', label: 'PR closed' },
  { kind: 'run_failed', label: 'Run failed' },
  { kind: 'budget_exceeded', label: 'Budget exceeded' },
  { kind: 'llm_failover', label: 'LLM failover' },
  { kind: 'task_completed', label: 'Task completed' },
  { kind: 'merge_gate_failed', label: 'Merge gate gave up' },
  { kind: 'job_failed', label: 'Scheduled job failed' },
];

export function channelEventLabel(kind: string): string {
  return NOTIFICATION_CHANNEL_EVENTS.find((event) => event.kind === kind)?.label ?? kind;
}

export function toggleEvent(events: string[], kind: string): string[] {
  return events.includes(kind) ? events.filter((event) => event !== kind) : [...events, kind];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Client-side target validation; the backend re-validates (SSRF included). */
export function channelTargetError(channel: NotificationChannelKind, target: string): string | null {
  if (channel === 'email') {
    return EMAIL_PATTERN.test(target) ? null : 'Enter a valid email address';
  }
  try {
    const url = new URL(target);
    if (url.protocol === 'https:' || url.protocol === 'http:') return null;
  } catch {
    // fall through to the error below
  }
  return 'Enter an http(s) URL';
}
