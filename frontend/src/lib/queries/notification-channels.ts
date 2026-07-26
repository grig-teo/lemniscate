/** Notification channel queries and mutations (Settings → Notifications;
 * CRUD + test-send under /api/notifications/channels). */
import { useMutation, useQuery } from '@tanstack/react-query';

// Mutations whose callers already render the error inline (dialogs, settings
// forms) opt out of the global MutationCache error toast with this meta.
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';
import { useInvalidator } from '@/lib/queries/invalidate';
import {
  createNotificationChannel,
  deleteNotificationChannel,
  fetchNotificationChannels,
  testNotificationChannel,
  updateNotificationChannel,
  type NotificationChannelPatch,
} from '@/lib/notification-channels';

function useInvalidateNotificationChannels() {
  return useInvalidator(['notification-channels']);
}

export function useNotificationChannels() {
  return useQuery({
    queryKey: ['notification-channels'],
    queryFn: fetchNotificationChannels,
  });
}

export function useCreateNotificationChannel() {
  const invalidate = useInvalidateNotificationChannels();
  return useMutation({
    mutationFn: createNotificationChannel,
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // NotificationsSection renders the error inline
  });
}

export function useUpdateNotificationChannel() {
  const invalidate = useInvalidateNotificationChannels();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: NotificationChannelPatch }) =>
      updateNotificationChannel(id, patch),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

export function useDeleteNotificationChannel() {
  const invalidate = useInvalidateNotificationChannels();
  return useMutation({
    mutationFn: deleteNotificationChannel,
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // NotificationsSection renders isError inline
  });
}

/** Synchronous test delivery; onSettled so the row's lastDelivery refreshes. */
export function useTestNotificationChannel() {
  const invalidate = useInvalidateNotificationChannels();
  return useMutation({
    mutationFn: testNotificationChannel,
    onSettled: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // NotificationsSection renders the result inline
  });
}
