/** LLM-config queries and mutations (GET/POST/PATCH /api/llm-configs…). */
import { useMutation, useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { LlmConfig, LlmConfigPayload, LlmTestResult } from '@/lib/api-types';
// Mutations whose callers already render the error inline (dialogs, settings
// forms) opt out of the global MutationCache error toast with this meta.
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';
import { useInvalidator } from '@/lib/queries/invalidate';

function useInvalidateLlmConfigs() {
  return useInvalidator(['llm-configs']);
}

export function useLlmConfigs() {
  return useQuery({
    queryKey: ['llm-configs'],
    queryFn: () =>
      api.get<{ configs: LlmConfig[] }>('/api/llm-configs').then((res) => res.configs),
  });
}

export function useCreateLlmConfig() {
  const invalidate = useInvalidateLlmConfigs();
  return useMutation({
    mutationFn: (payload: LlmConfigPayload) => api.post<LlmConfig>('/api/llm-configs', payload),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // LlmConfigForm renders the save error inline
  });
}

export function useUpdateLlmConfig() {
  const invalidate = useInvalidateLlmConfigs();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: LlmConfigPayload }) =>
      api.patch<LlmConfig>(`/api/llm-configs/${id}`, payload),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // LlmConfigForm renders the save error inline
  });
}

export function useDeleteLlmConfig() {
  const invalidate = useInvalidateLlmConfigs();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/llm-configs/${id}`),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // LlmConfigsSection renders isError inline
  });
}

/**
 * Test an LLM config without saving first. Pass `{ id }` to test a saved
 * config (backend uses the stored API key), or `{ payload }` to test the
 * form contents (e.g. before saving, or with a newly typed API key).
 */
export function useTestLlmConfig() {
  return useMutation({
    mutationFn: (args: { id: string } | { payload: LlmConfigPayload }) =>
      'id' in args
        ? api.post<LlmTestResult>(`/api/llm-configs/${args.id}/test`)
        : api.post<LlmTestResult>('/api/llm-configs/test', args.payload),
    meta: SUPPRESS_ERROR_TOAST_META, // useLlmConfigForm renders the test result inline
  });
}
