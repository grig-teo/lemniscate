// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import {
  BROWSER_NOTIFICATIONS_STORAGE_KEY,
  DEFAULT_BROWSER_NOTIFICATION_SETTINGS,
  SELECTABLE_BROWSER_NOTIFICATION_KINDS,
  browserNotificationPermission,
  browserNotificationsSupported,
  normalizeBrowserNotificationSettings,
  newlyArrivedUnread,
  readBrowserNotificationSettings,
  requestBrowserNotificationPermission,
  shouldFireBrowserNotification,
  showBrowserNotification,
  toggleBrowserKind,
  useFireBrowserNotifications,
  type BrowserNotificationSettings,
} from '@/lib/browser-notifications';
import type { AppNotification } from '@/lib/notifications';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function settings(overrides: Partial<BrowserNotificationSettings> = {}): BrowserNotificationSettings {
  return { ...DEFAULT_BROWSER_NOTIFICATION_SETTINGS, ...overrides };
}

// ---------------------------------------------------------------------------
// normalizeBrowserNotificationSettings
// ---------------------------------------------------------------------------

describe('normalizeBrowserNotificationSettings', () => {
  it('falls back to defaults for null/undefined', () => {
    expect(normalizeBrowserNotificationSettings(null)).toEqual(DEFAULT_BROWSER_NOTIFICATION_SETTINGS);
    expect(normalizeBrowserNotificationSettings(undefined)).toEqual(DEFAULT_BROWSER_NOTIFICATION_SETTINGS);
  });

  it('falls back to defaults for non-object values', () => {
    expect(normalizeBrowserNotificationSettings('oops')).toEqual(DEFAULT_BROWSER_NOTIFICATION_SETTINGS);
    expect(normalizeBrowserNotificationSettings(42)).toEqual(DEFAULT_BROWSER_NOTIFICATION_SETTINGS);
  });

  it('keeps a well-formed object and defaults missing fields', () => {
    expect(normalizeBrowserNotificationSettings({ enabled: true })).toEqual({
      enabled: true,
      kinds: DEFAULT_BROWSER_NOTIFICATION_SETTINGS.kinds,
    });
  });

  it('defaults enabled to false when not a boolean', () => {
    expect(normalizeBrowserNotificationSettings({ enabled: 'yes' }).enabled).toBe(false);
  });

  it('drops non-string kind entries and falls back when kinds is not an array', () => {
    const out = normalizeBrowserNotificationSettings({ enabled: true, kinds: ['pr_opened', 7, null, 'run_failed'] });
    expect(out.kinds).toEqual(['pr_opened', 'run_failed']);
    expect(normalizeBrowserNotificationSettings({ kinds: 'nope' }).kinds).toEqual(
      DEFAULT_BROWSER_NOTIFICATION_SETTINGS.kinds,
    );
  });

  it('does not mutate the shared default kinds array', () => {
    normalizeBrowserNotificationSettings({ enabled: true, kinds: ['pr_opened'] });
    expect(DEFAULT_BROWSER_NOTIFICATION_SETTINGS.kinds).toContain('run_failed');
  });
});

// ---------------------------------------------------------------------------
// shouldFireBrowserNotification
// ---------------------------------------------------------------------------

describe('shouldFireBrowserNotification', () => {
  it('fires when enabled and the kind is selected', () => {
    expect(shouldFireBrowserNotification(settings({ enabled: true, kinds: ['run_failed'] }), 'run_failed')).toBe(true);
  });

  it('does not fire when the kind is not selected', () => {
    expect(shouldFireBrowserNotification(settings({ enabled: true, kinds: ['pr_opened'] }), 'run_failed')).toBe(false);
  });

  it('never fires when disabled, even for a selected kind', () => {
    expect(shouldFireBrowserNotification(settings({ enabled: false, kinds: ['run_failed'] }), 'run_failed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toggleBrowserKind
// ---------------------------------------------------------------------------

describe('toggleBrowserKind', () => {
  it('adds a missing kind', () => {
    expect(toggleBrowserKind(['pr_opened'], 'run_failed')).toEqual(['pr_opened', 'run_failed']);
  });

  it('removes an existing kind', () => {
    expect(toggleBrowserKind(['pr_opened', 'run_failed'], 'pr_opened')).toEqual(['run_failed']);
  });

  it('does not mutate the input array', () => {
    const input = ['pr_opened'];
    toggleBrowserKind(input, 'run_failed');
    expect(input).toEqual(['pr_opened']);
  });
});

// ---------------------------------------------------------------------------
// newlyArrivedUnread
// ---------------------------------------------------------------------------

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    kind: 'pr_opened',
    title: 'PR opened',
    body: 'org/demo',
    taskId: 't1',
    prUrl: null,
    readAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('newlyArrivedUnread', () => {
  it('returns unread notifications not seen before', () => {
    const current = [notification({ id: 'a' }), notification({ id: 'b' })];
    const fresh = newlyArrivedUnread(new Set(['a']), current);
    expect(fresh.map((n) => n.id)).toEqual(['b']);
  });

  it('excludes already-read notifications even when unseen', () => {
    const current = [
      notification({ id: 'a', readAt: '2026-01-02T00:00:00Z' }),
      notification({ id: 'b' }),
    ];
    const fresh = newlyArrivedUnread(new Set<string>(), current);
    expect(fresh.map((n) => n.id)).toEqual(['b']);
  });

  it('returns nothing when everything was already seen', () => {
    const current = [notification({ id: 'a' })];
    expect(newlyArrivedUnread(new Set(['a']), current)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// localStorage read/write round-trip
// ---------------------------------------------------------------------------

describe('readBrowserNotificationSettings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(readBrowserNotificationSettings()).toEqual(DEFAULT_BROWSER_NOTIFICATION_SETTINGS);
  });

  it('round-trips a persisted settings object', () => {
    window.localStorage.setItem(
      BROWSER_NOTIFICATIONS_STORAGE_KEY,
      JSON.stringify({ enabled: true, kinds: ['run_failed'] }),
    );
    expect(readBrowserNotificationSettings()).toEqual({ enabled: true, kinds: ['run_failed'] });
  });

  it('falls back when the stored JSON is corrupt', () => {
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, '{not json');
    expect(readBrowserNotificationSettings()).toEqual(DEFAULT_BROWSER_NOTIFICATION_SETTINGS);
  });
});

// ---------------------------------------------------------------------------
// Browser Notification API wrappers
// ---------------------------------------------------------------------------

describe('browser notification wrappers', () => {
  beforeEach(() => {
    // jsdom ships no Notification constructor by default.
    delete (window as unknown as { Notification?: unknown }).Notification;
  });

  it('reports unsupported when the API is absent', () => {
    expect(browserNotificationsSupported()).toBe(false);
    expect(browserNotificationPermission()).toBe(null);
  });

  it('reports supported and reads permission when the API is present', () => {
    stubNotification('default');
    expect(browserNotificationsSupported()).toBe(true);
    expect(browserNotificationPermission()).toBe('default');
  });

  it('fires an OS notification only when permission is granted', () => {
    const ctor = stubNotification('granted');
    showBrowserNotification(notification({ id: 'x', kind: 'run_failed', title: 'Build broke' }));
    expect(ctor).toHaveBeenCalledWith('Run failed', expect.objectContaining({ body: 'Build broke', tag: 'x' }));
  });

  it('is a no-op when permission is not granted', () => {
    const ctor = stubNotification('denied');
    showBrowserNotification(notification());
    expect(ctor).not.toHaveBeenCalled();
  });

  it('is a no-op when the API is unsupported', () => {
    showBrowserNotification(notification());
    // no throw, nothing to assert beyond reaching here
  });

  it('requests permission through the browser API', async () => {
    const api = stubNotification('default');
    api.requestPermission = vi.fn().mockResolvedValue('granted');
    await expect(requestBrowserNotificationPermission()).resolves.toBe('granted');
    expect(api.requestPermission).toHaveBeenCalled();
  });

  it('resolves to denied when unsupported', async () => {
    await expect(requestBrowserNotificationPermission()).resolves.toBe('denied');
  });
});

// ---------------------------------------------------------------------------
// useFireBrowserNotifications hook
// ---------------------------------------------------------------------------

describe('useFireBrowserNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('seeds seen ids on mount and does not fire for pre-existing notifications', () => {
    const ctor = stubNotification('granted');
    window.localStorage.setItem(
      BROWSER_NOTIFICATIONS_STORAGE_KEY,
      JSON.stringify({ enabled: true, kinds: ['run_failed'] }),
    );
    renderHook(({ list }: { list: AppNotification[] }) => useFireBrowserNotifications(list), {
      initialProps: { list: [notification({ id: 'a', kind: 'run_failed' })] },
    });
    expect(ctor).not.toHaveBeenCalled();
  });

  it('fires for genuinely new matching notifications after mount', () => {
    const ctor = stubNotification('granted');
    window.localStorage.setItem(
      BROWSER_NOTIFICATIONS_STORAGE_KEY,
      JSON.stringify({ enabled: true, kinds: ['run_failed'] }),
    );
    const { rerender } = renderHook(({ list }: { list: AppNotification[] }) => useFireBrowserNotifications(list), {
      initialProps: { list: [notification({ id: 'a', kind: 'run_failed' })] },
    });
    act(() => {
      rerender({ list: [notification({ id: 'a', kind: 'run_failed' }), notification({ id: 'b', kind: 'run_failed' })] });
    });
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledWith('Run failed', expect.objectContaining({ tag: 'b' }));
  });

  it('skips notifications whose kind is not selected', () => {
    const ctor = stubNotification('granted');
    window.localStorage.setItem(
      BROWSER_NOTIFICATIONS_STORAGE_KEY,
      JSON.stringify({ enabled: true, kinds: ['pr_opened'] }),
    );
    const { rerender } = renderHook(({ list }: { list: AppNotification[] }) => useFireBrowserNotifications(list), {
      initialProps: { list: [] as AppNotification[] },
    });
    act(() => {
      rerender({ list: [notification({ id: 'b', kind: 'run_failed' })] });
    });
    expect(ctor).not.toHaveBeenCalled();
  });

  it('does nothing when browser notifications are disabled', () => {
    const ctor = stubNotification('granted');
    window.localStorage.setItem(
      BROWSER_NOTIFICATIONS_STORAGE_KEY,
      JSON.stringify({ enabled: false, kinds: ['run_failed'] }),
    );
    const { rerender } = renderHook(({ list }: { list: AppNotification[] }) => useFireBrowserNotifications(list), {
      initialProps: { list: [] as AppNotification[] },
    });
    act(() => {
      rerender({ list: [notification({ id: 'b', kind: 'run_failed' })] });
    });
    expect(ctor).not.toHaveBeenCalled();
  });
});

describe('SELECTABLE_BROWSER_NOTIFICATION_KINDS', () => {
  it('lists the in-app notification kinds that can trigger a browser popup', () => {
    expect(SELECTABLE_BROWSER_NOTIFICATION_KINDS).toEqual([
      'pr_opened',
      'pr_merged',
      'pr_closed',
      'run_failed',
      'budget_exceeded',
      'llm_failover',
    ]);
  });
});

// ---------------------------------------------------------------------------
// test helpers
// ---------------------------------------------------------------------------

/** Installs a fake `window.Notification` and returns its constructor mock. */
function stubNotification(permission: NotificationPermission) {
  const ctor = vi.fn();
  const api = Object.assign(ctor, {
    permission,
    requestPermission: vi.fn().mockResolvedValue(permission),
  });
  Object.defineProperty(window, 'Notification', { value: api, configurable: true, writable: true });
  return api;
}
