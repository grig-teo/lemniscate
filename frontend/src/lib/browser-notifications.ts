/**
 * Browser (desktop/OS) notifications: a client-only, per-browser preference
 * layered on top of the in-app notification bell. Unlike the server-side
 * webhook/email channels in lib/notification-channels.ts, these fire the Web
 * Notifications API directly from the tab — so the on/off toggle and the
 * per-kind selection live in localStorage, the same place the theme does.
 *
 * Pure helpers (normalize/shouldFire/newlyArrivedUnread/toggleBrowserKind)
 * are unit-tested in browser-notifications.test.ts; the thin browser wrappers
 * and the firing hook sit below them.
 */
import { useEffect, useRef } from 'react';

import {
  notificationKindLabel,
  type AppNotification,
  type NotificationKind,
} from '@/lib/notifications';
import { readPersisted, writePersisted } from '@/lib/persist';

/** localStorage key for the persisted settings object. */
export const BROWSER_NOTIFICATIONS_STORAGE_KEY = 'lemniscate-browser-notifications';

/**
 * The in-app notification kinds a browser popup can be raised for, in display
 * order. Labels come from the single source of truth in lib/notifications.ts
 * (notificationKindLabel) so they can never drift from the bell.
 */
export const SELECTABLE_BROWSER_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'pr_opened',
  'pr_merged',
  'pr_closed',
  'run_failed',
  'budget_exceeded',
  'llm_failover',
];

/** Kinds enabled by default once the user turns the master toggle on. */
export const DEFAULT_BROWSER_NOTIFICATION_KINDS: NotificationKind[] = [
  'pr_opened',
  'pr_merged',
  'run_failed',
  'budget_exceeded',
  'llm_failover',
];

export type BrowserNotificationSettings = {
  enabled: boolean;
  kinds: NotificationKind[];
};

export const DEFAULT_BROWSER_NOTIFICATION_SETTINGS: BrowserNotificationSettings = {
  enabled: false,
  kinds: [...DEFAULT_BROWSER_NOTIFICATION_KINDS],
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Defensive parse of whatever lives in localStorage into a valid settings
 * object. Any shape we cannot trust falls back to the (cloned) defaults so a
 * corrupted or hand-edited value can never break the bell.
 */
export function normalizeBrowserNotificationSettings(
  raw: unknown,
): BrowserNotificationSettings {
  if (!isRecord(raw)) return cloneDefaults();
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
    kinds: parseKinds(raw.kinds),
  };
}

function parseKinds(raw: unknown): NotificationKind[] {
  if (!Array.isArray(raw)) return [...DEFAULT_BROWSER_NOTIFICATION_KINDS];
  const kinds = raw.filter((k): k is NotificationKind => typeof k === 'string');
  return kinds.length > 0 ? kinds : [...DEFAULT_BROWSER_NOTIFICATION_KINDS];
}

function cloneDefaults(): BrowserNotificationSettings {
  return {
    enabled: DEFAULT_BROWSER_NOTIFICATION_SETTINGS.enabled,
    kinds: [...DEFAULT_BROWSER_NOTIFICATION_SETTINGS.kinds],
  };
}

/** True only when browser notifications are on AND this kind is selected. */
export function shouldFireBrowserNotification(
  settings: BrowserNotificationSettings,
  kind: NotificationKind,
): boolean {
  return settings.enabled && settings.kinds.includes(kind);
}

/** Adds a kind if absent, removes it if present; returns a new array. */
export function toggleBrowserKind(kinds: readonly NotificationKind[], kind: NotificationKind): NotificationKind[] {
  return kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
}

/**
 * Returns the unread notifications from `current` whose ids were not in
 * `previousIds` — i.e. genuinely new arrivals worth surfacing as an OS popup.
 */
export function newlyArrivedUnread(
  previousIds: ReadonlySet<string>,
  current: readonly AppNotification[],
): AppNotification[] {
  return current.filter((n) => n.readAt === null && !previousIds.has(n.id));
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

/** Reads + normalizes the persisted settings (defaults when nothing stored). */
export function readBrowserNotificationSettings(): BrowserNotificationSettings {
  return normalizeBrowserNotificationSettings(
    readPersisted<unknown>(BROWSER_NOTIFICATIONS_STORAGE_KEY, null),
  );
}

/** Persists settings; storage failures are non-fatal (best-effort, like theme). */
export function writeBrowserNotificationSettings(settings: BrowserNotificationSettings): void {
  writePersisted(BROWSER_NOTIFICATIONS_STORAGE_KEY, settings);
}

// ---------------------------------------------------------------------------
// Thin Web Notifications API wrappers (no-ops when unsupported)
// ---------------------------------------------------------------------------

export function browserNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification !== 'undefined';
}

/** Current permission, or null when the API is unavailable. */
export function browserNotificationPermission(): NotificationPermission | null {
  return browserNotificationsSupported() ? window.Notification.permission : null;
}

/**
 * Ensures permission is granted, requesting it if still 'default'. Returns
 * 'denied' when unsupported or after the user blocks the prompt — callers use
 * the result to decide whether to flip the master toggle on.
 */
export async function requestBrowserNotificationPermission(): Promise<NotificationPermission> {
  if (!browserNotificationsSupported()) return 'denied';
  if (window.Notification.permission === 'granted') return 'granted';
  return window.Notification.requestPermission();
}

/**
 * Raises one OS notification for an in-app event. Safe to call unconditionally:
 * it no-ops when the API is missing or permission was not granted. The `tag`
 * is the notification id so the browser dedupes re-fires for the same event.
 */
export function showBrowserNotification(notification: AppNotification): void {
  if (!browserNotificationsSupported()) return;
  if (window.Notification.permission !== 'granted') return;
  new window.Notification(notificationKindLabel(notification.kind), {
    body: notification.title,
    tag: notification.id,
  });
}

// ---------------------------------------------------------------------------
// React hook: fire OS popups for new matching notifications
// ---------------------------------------------------------------------------

/**
 * Watches the bell's notification list and raises a browser popup for each
 * genuinely new, unread notification whose kind the user opted into. The set
 * of already-seen ids is seeded on first run so notifications that existed
 * before mount never fire retroactively.
 */
export function useFireBrowserNotifications(notifications: readonly AppNotification[]): void {
  // null until the first effect seeds it from the initial list.
  const seenIds = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    const ids = new Set(notifications.map((n) => n.id));
    if (seenIds.current === null) {
      seenIds.current = ids;
      return;
    }
    const fresh = newlyArrivedUnread(seenIds.current, notifications);
    seenIds.current = ids;
    fireMatching(fresh);
  }, [notifications]);
}

function fireMatching(notifications: readonly AppNotification[]): void {
  if (notifications.length === 0) return;
  const settings = readBrowserNotificationSettings();
  if (!settings.enabled) return;
  for (const n of notifications) {
    if (shouldFireBrowserNotification(settings, n.kind)) showBrowserNotification(n);
  }
}
