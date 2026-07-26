/**
 * In-app notifications (async agent events: PR opened/merged/closed, run
 * failed, token budget exceeded). The TopNav bell polls the list endpoint;
 * the pure reducer below drives the unread badge and the optimistic updates
 * after mark-read so the badge never waits for the next poll.
 */
import { api } from '@/lib/api';

export type NotificationKind =
  | 'pr_opened'
  | 'pr_merged'
  | 'pr_closed'
  | 'run_failed'
  | 'budget_exceeded'
  | (string & {});

export type AppNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  taskId: string | null;
  prUrl: string | null;
  readAt: string | null;
  createdAt: string;
};

export type NotificationList = {
  notifications: AppNotification[];
  unreadCount: number;
};

/** Bell poll cadence — matches the backend's <= 30s visibility target. */
export const NOTIFICATIONS_REFETCH_INTERVAL_MS = 30_000;

export function fetchNotifications(): Promise<NotificationList> {
  return api.get<NotificationList>('/api/notifications');
}

export function markNotificationRead(id: string): Promise<{ updated: number }> {
  return api.post<{ updated: number }>(`/api/notifications/${id}/read`);
}

export function markAllNotificationsRead(): Promise<{ updated: number }> {
  return api.post<{ updated: number }>('/api/notifications/read-all');
}

// ---------------------------------------------------------------------------
// Pure state helpers (unit-tested; the bell mutates through these)
// ---------------------------------------------------------------------------

export function isUnread(notification: AppNotification): boolean {
  return notification.readAt === null;
}

export function notificationKindLabel(kind: NotificationKind): string {
  switch (kind) {
    case 'pr_opened':
      return 'PR opened';
    case 'pr_merged':
      return 'PR merged';
    case 'pr_closed':
      return 'PR closed';
    case 'run_failed':
      return 'Run failed';
    case 'budget_exceeded':
      return 'Budget exceeded';
    default:
      return 'Notification';
  }
}

export type NotificationAction = { type: 'read'; id: string } | { type: 'read-all' };

/** Unread-count reducer: recomputes the list + badge after a mark-read action. */
export function reduceNotifications(
  list: NotificationList,
  action: NotificationAction,
  readAt: string,
): NotificationList {
  const notifications = list.notifications.map((notification) =>
    (action.type === 'read-all' || notification.id === action.id) && notification.readAt === null
      ? { ...notification, readAt }
      : notification,
  );
  return { notifications, unreadCount: notifications.filter(isUnread).length };
}
