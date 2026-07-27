/** Event trigger domain: CRUD under /api/repositories/:id/triggers. */
import { useMutation, useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { EventTrigger, EventTriggerKind } from '@/lib/api-types';
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';
import { useInvalidator } from '@/lib/queries/invalidate';

export type EventTriggerInput = {
  eventKind: EventTriggerKind;
  taskPrompt: string;
  enabled?: boolean;
};

export type EventTriggerPatch = {
  taskPrompt?: string;
  enabled?: boolean;
};

function queryKey(repositoryId: string | null) {
  return ['event-triggers', repositoryId] as const;
}

function useInvalidateTriggers(repositoryId: string | null) {
  return useInvalidator(queryKey(repositoryId));
}

/** GET /api/repositories/:id/triggers — list a repository's event triggers. */
export function useEventTriggers(repositoryId: string | null) {
  return useQuery({
    queryKey: queryKey(repositoryId),
    queryFn: () =>
      api
        .get<{ triggers: EventTrigger[] }>(`/api/repositories/${repositoryId}/triggers`)
        .then((res) => res.triggers),
    enabled: repositoryId !== null,
  });
}

export function useCreateEventTrigger(repositoryId: string | null) {
  const invalidate = useInvalidateTriggers(repositoryId);
  return useMutation({
    mutationFn: (input: EventTriggerInput) =>
      api
        .post<{ trigger: EventTrigger }>(`/api/repositories/${repositoryId}/triggers`, input)
        .then((res) => res.trigger),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

export function useUpdateEventTrigger(repositoryId: string | null) {
  const invalidate = useInvalidateTriggers(repositoryId);
  return useMutation({
    mutationFn: ({ triggerId, patch }: { triggerId: string; patch: EventTriggerPatch }) =>
      api.patch<{ trigger: EventTrigger }>(
        `/api/repositories/${repositoryId}/triggers/${triggerId}`,
        patch,
      ),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

export function useDeleteEventTrigger(repositoryId: string | null) {
  const invalidate = useInvalidateTriggers(repositoryId);
  return useMutation({
    mutationFn: (triggerId: string) =>
      api.del(`/api/repositories/${repositoryId}/triggers/${triggerId}`),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}
