import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, ExternalLink } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import {
  fetchNotifications,
  isUnread,
  markAllNotificationsRead,
  markNotificationRead,
  notificationKindLabel,
  NOTIFICATIONS_REFETCH_INTERVAL_MS,
  reduceNotifications,
  type AppNotification,
  type NotificationList,
} from '@/lib/notifications';
import type { Task } from '@/lib/hooks';
import { useWorkspaceSelection } from '@/lib/selection';

const QUERY_KEY = ['notifications'] as const;

/**
 * Notification bell for the top navigation: unread-count badge fed by a 30s
 * TanStack Query poll, dropdown with the latest events, click-through to the
 * PR (new tab) or the task console. Mark-read is optimistic via the pure
 * reducer in lib/notifications so the badge updates without a refetch.
 */
export function NotificationBell() {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchNotifications,
    refetchInterval: NOTIFICATIONS_REFETCH_INTERVAL_MS,
  });

  const applyAction = React.useCallback(
    (action: Parameters<typeof reduceNotifications>[1]) => {
      queryClient.setQueryData<NotificationList>(QUERY_KEY, (old) =>
        old ? reduceNotifications(old, action, new Date().toISOString()) : old,
      );
    },
    [queryClient],
  );

  const readMutation = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: (_res, id) => applyAction({ type: 'read', id }),
  });
  const readAllMutation = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => applyAction({ type: 'read-all' }),
  });

  const unreadCount = query.data?.unreadCount ?? 0;
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>
      {open && (
        <NotificationDropdown
          notifications={query.data?.notifications ?? []}
          onRead={(id) => readMutation.mutate(id)}
          onReadAll={() => readAllMutation.mutate()}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

interface DropdownProps {
  notifications: AppNotification[];
  onRead: (id: string) => void;
  onReadAll: () => void;
  onClose: () => void;
}

function NotificationDropdown({ notifications, onRead, onReadAll, onClose }: DropdownProps) {
  return (
    <div className="absolute right-0 top-full z-50 mt-2 w-96 rounded-md border bg-popover shadow-md">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">Notifications</span>
        <Button variant="ghost" size="sm" onClick={onReadAll} aria-label="Mark all read">
          <CheckCheck className="mr-1 h-4 w-4" /> Mark all read
        </Button>
      </div>
      <div className="max-h-96 overflow-y-auto">
        {notifications.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No notifications yet
          </p>
        ) : (
          notifications.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              onRead={onRead}
              onClose={onClose}
            />
          ))
        )}
      </div>
    </div>
  );
}

function NotificationRow({
  notification,
  onRead,
  onClose,
}: {
  notification: AppNotification;
  onRead: (id: string) => void;
  onClose: () => void;
}) {
  const { selectTask } = useWorkspaceSelection();

  const handleClick = async () => {
    if (isUnread(notification)) onRead(notification.id);
    if (notification.prUrl) {
      window.open(notification.prUrl, '_blank', 'noopener,noreferrer');
    } else if (notification.taskId) {
      await openTaskConsole(notification.taskId, selectTask);
    }
    onClose();
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      className="flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent"
    >
      <span className="flex items-center gap-2">
        {isUnread(notification) && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />
        )}
        <span className="text-xs text-muted-foreground">
          {notificationKindLabel(notification.kind)}
        </span>
        {notification.prUrl && <ExternalLink className="h-3 w-3 text-muted-foreground" />}
      </span>
      <span className="text-sm font-medium">{notification.title}</span>
      <span className="line-clamp-2 text-xs text-muted-foreground">{notification.body}</span>
    </button>
  );
}

// Click-through to the task console: load the task (for title/status), then
// select it in the workspace. A 404 (archived-away task) is ignored — the
// notification was still marked read.
async function openTaskConsole(
  taskId: string,
  selectTask: (task: Task | null) => void,
): Promise<void> {
  try {
    const { task } = await api.get<{ task: Task }>(`/api/tasks/${taskId}`);
    selectTask(task);
  } catch {
    // Task no longer visible; nothing to open.
  }
}
