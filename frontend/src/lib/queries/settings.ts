/** Per-user settings hooks (Settings → Agent tab): the core agent executor
 *  backed by GET /api/settings and PUT /api/settings/agent-executor. */
import { useMutation, useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { AgentExecutor, AgentSettings } from '@/lib/api-types';
// The AgentSection renders mutation errors inline, so opt out of the global
// MutationCache error toast.
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';
import { useInvalidator } from '@/lib/queries/invalidate';

/** Effective agent executor, the env default, and the stored override. */
export function useAgentSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<AgentSettings>('/api/settings'),
    staleTime: 30_000,
  });
}

/** Stores the user's core agent choice and refreshes the settings query. */
export function useUpdateAgentExecutor() {
  const invalidate = useInvalidator(['settings']);
  return useMutation({
    mutationFn: (agentExecutor: AgentExecutor) =>
      api.put<AgentSettings>('/api/settings/agent-executor', { agentExecutor }),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}
