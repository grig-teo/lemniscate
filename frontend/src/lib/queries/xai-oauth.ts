/** xAI Grok OAuth device-code hooks (Settings → LLM configs). */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { LlmConfig } from '@/lib/api-types';
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';

export type XaiOauthStart = {
  sessionId: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
  defaultModel: string;
  models: string[];
};

export type XaiOauthPoll =
  | { status: 'pending' }
  | { status: 'slow_down'; interval?: number }
  | { status: 'authorized' };

export type XaiOauthCompletePayload = {
  sessionId: string;
  model: string;
  name?: string;
  isDefault?: boolean;
};

export function useStartXaiOauth() {
  return useMutation({
    mutationFn: () => api.post<XaiOauthStart>('/api/llm-configs/xai-oauth/start'),
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

export function usePollXaiOauth() {
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.post<XaiOauthPoll>('/api/llm-configs/xai-oauth/poll', { sessionId }),
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

export function useCompleteXaiOauth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: XaiOauthCompletePayload) =>
      api.post<LlmConfig>('/api/llm-configs/xai-oauth/complete', payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['llm-configs'] });
    },
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}
