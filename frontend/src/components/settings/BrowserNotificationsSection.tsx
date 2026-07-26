import * as React from 'react';
import { Bell, BellRing } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { notificationKindLabel, type AppNotification } from '@/lib/notifications';
import {
  SELECTABLE_BROWSER_NOTIFICATION_KINDS,
  browserNotificationPermission,
  browserNotificationsSupported,
  readBrowserNotificationSettings,
  requestBrowserNotificationPermission,
  showBrowserNotification,
  toggleBrowserKind,
  writeBrowserNotificationSettings,
  type BrowserNotificationSettings,
} from '@/lib/browser-notifications';

/** A throwaway event used by the "Send test notification" button. */
const TEST_NOTIFICATION: AppNotification = {
  id: 'browser-notification-test',
  kind: 'pr_opened',
  title: 'This is how a Lemniscate browser notification looks.',
  body: '',
  taskId: null,
  prUrl: null,
  readAt: null,
  createdAt: '2026-01-01T00:00:00Z',
};

/**
 * Browser (desktop/OS) notifications section of the Notifications tab. A
 * master switch requests the Web Notifications permission; below it the user
 * picks which in-app event kinds should also pop up an OS notification. The
 * selection is a per-browser preference persisted to localStorage.
 */
export function BrowserNotificationsSection() {
  const [settings, setSettings] = React.useState<BrowserNotificationSettings>(
    readBrowserNotificationSettings,
  );
  const [permission, setPermission] = React.useState<NotificationPermission | null>(
    browserNotificationPermission,
  );
  const supported = browserNotificationsSupported();

  function persist(next: BrowserNotificationSettings) {
    setSettings(next);
    writeBrowserNotificationSettings(next);
  }

  async function handleToggleEnabled(enabled: boolean) {
    if (!enabled) {
      persist({ ...settings, enabled: false });
      return;
    }
    const result = await requestBrowserNotificationPermission();
    setPermission(result);
    if (result === 'granted') persist({ ...settings, enabled: true });
  }

  const blocked = supported && permission === 'denied';

  return (
    <div className="flex flex-col gap-4 py-2">
      {!supported && <UnsupportedNote />}
      {supported && (
        <div className="flex flex-col gap-3 rounded-md border px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-sm font-medium">
                {settings.enabled ? <BellRing className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                Browser notifications
              </span>
              <span className="text-xs text-muted-foreground">
                Pop up an OS notification in addition to the bell.
              </span>
            </div>
            <Switch
              checked={settings.enabled}
              onCheckedChange={handleToggleEnabled}
              aria-label={settings.enabled ? 'Disable browser notifications' : 'Enable browser notifications'}
            />
          </div>
          <PermissionNote permission={permission} enabled={settings.enabled} />
        </div>
      )}

      {supported && settings.enabled && !blocked && (
        <KindCheckboxes kinds={settings.kinds} onToggle={(kind) => persist({ ...settings, kinds: toggleBrowserKind(settings.kinds, kind) })} />
      )}

      {supported && settings.enabled && !blocked && (
        <div>
          <Button variant="outline" size="sm" onClick={() => showBrowserNotification(TEST_NOTIFICATION)}>
            <BellRing className="h-4 w-4" />
            Send test notification
          </Button>
        </div>
      )}
    </div>
  );
}

function UnsupportedNote() {
  return (
    <p className="text-sm text-muted-foreground">
      This browser does not support desktop notifications. Try a recent Chrome, Firefox, Edge, or
      Safari build.
    </p>
  );
}

function PermissionNote({
  permission,
  enabled,
}: {
  permission: NotificationPermission | null;
  enabled: boolean;
}) {
  if (permission === 'denied') {
    return (
      <p className="text-xs text-destructive">
        Blocked — you denied the notification permission. Re-enable it from your browser&rsquo;s
        site settings for this page.
      </p>
    );
  }
  if (enabled && permission === 'granted') {
    return <p className="text-xs text-emerald-500">Allowed — browser notifications are on.</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      Turning this on asks your browser for permission to show desktop notifications.
    </p>
  );
}

function KindCheckboxes({
  kinds,
  onToggle,
}: {
  kinds: readonly string[];
  onToggle: (kind: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Notify me about</span>
      <div className="grid grid-cols-2 gap-1.5">
        {SELECTABLE_BROWSER_NOTIFICATION_KINDS.map((kind) => (
          <label key={kind} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={kinds.includes(kind)}
              onChange={() => onToggle(kind)}
            />
            {notificationKindLabel(kind)}
          </label>
        ))}
      </div>
    </div>
  );
}
