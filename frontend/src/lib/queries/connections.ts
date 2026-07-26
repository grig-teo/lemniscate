/** Git-host connection queries and mutations (GET/POST /api/connections…). */
import { useMutation, useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { Connection, ConnectionPayload } from '@/lib/api-types';
// Mutations whose callers already render the error inline (dialogs, settings
// forms) opt out of the global MutationCache error toast with this meta.
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';
import { useInvalidator } from '@/lib/queries/invalidate';

/** Connections affect the repo list (sync runs server-side on connect). */
function useInvalidateConnections() {
  return useInvalidator(['connections'], ['repositories'], ['tasks']);
}

export function useConnections() {
  return useQuery({
    queryKey: ['connections'],
    queryFn: () =>
      api.get<{ connections: Connection[] }>('/api/connections').then((res) => res.connections),
  });
}

export function useCreateConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: (payload: ConnectionPayload) =>
      api
        .post<{ connection: Connection }>('/api/connections', payload)
        .then((res) => res.connection),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // GitVerseConnectDialog renders isError inline
  });
}

export function useDeleteConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/connections/${id}`),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // ConnectionsSection renders isError inline
  });
}

/** POST /api/connections/:id/sync — re-list repositories from the git host. */
export function useSyncConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ synced: number; created: number; updated: number }>(`/api/connections/${id}/sync`),
    onSettled: invalidate,
  });
}
