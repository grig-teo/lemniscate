import { describe, expect, it } from 'vitest';

import {
  isUnread,
  notificationKindLabel,
  reduceNotifications,
  type AppNotification,
  type NotificationList,
} from '@/lib/notifications';

function row(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    kind: 'pr_opened',
    title: 'PR opened: t',
    body: 'org/demo',
    taskId: 't1',
    prUrl: 'https://pr/1',
    readAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function list(...notifications: AppNotification[]): NotificationList {
  return { notifications, unreadCount: notifications.filter(isUnread).length };
}

const AT = '2026-01-02T00:00:00Z';

describe('isUnread', () => {
  it('treats a null readAt as unread', () => {
    expect(isUnread(row())).toBe(true);
    expect(isUnread(row({ readAt: AT }))).toBe(false);
  });
});

describe('notificationKindLabel', () => {
  it('labels every known kind and falls back for unknown ones', () => {
    expect(notificationKindLabel('pr_opened')).toBe('PR opened');
    expect(notificationKindLabel('pr_merged')).toBe('PR merged');
    expect(notificationKindLabel('pr_closed')).toBe('PR closed');
    expect(notificationKindLabel('run_failed')).toBe('Run failed');
    expect(notificationKindLabel('budget_exceeded')).toBe('Budget exceeded');
    expect(notificationKindLabel('future_kind')).toBe('Notification');
  });
});

describe('reduceNotifications', () => {
  it('marks a single notification read and recomputes the unread count', () => {
    const before = list(row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', readAt: AT }));
    const after = reduceNotifications(before, { type: 'read', id: 'a' }, AT);
    expect(after.unreadCount).toBe(1);
    expect(after.notifications.find((n) => n.id === 'a')?.readAt).toBe(AT);
    expect(after.notifications.find((n) => n.id === 'b')?.readAt).toBeNull();
  });

  it('marks everything read with read-all', () => {
    const before = list(row({ id: 'a' }), row({ id: 'b' }));
    const after = reduceNotifications(before, { type: 'read-all' }, AT);
    expect(after.unreadCount).toBe(0);
    expect(after.notifications.every((n) => n.readAt === AT)).toBe(true);
  });

  it('is idempotent for an already-read notification', () => {
    const earlier = '2026-01-01T12:00:00Z';
    const before = list(row({ id: 'a', readAt: earlier }));
    const after = reduceNotifications(before, { type: 'read', id: 'a' }, AT);
    expect(after.notifications[0]?.readAt).toBe(earlier);
    expect(after.unreadCount).toBe(0);
  });
});
