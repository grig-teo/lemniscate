/** VPS deployment targets domain: queries and mutations under /api/vps-targets. */
import { useMutation, useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';
import { useInvalidator } from '@/lib/queries/invalidate';

export type VpsAuthMethod = 'password' | 'key';

export interface VpsTarget {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: VpsAuthMethod;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export type VpsTargetInput = {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: VpsAuthMethod;
  secret: string;
};

export interface VpsTestResult {
  ok: boolean;
  echo?: string;
  error?: string;
}

const QUERY_KEY = ['vps-targets'] as const;

function useInvalidateTargets() {
  return useInvalidator(['vps-targets'], ['services']);
}

/** GET /api/vps-targets — list the user's saved SSH connection profiles. */
export function useVpsTargets() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<{ targets: VpsTarget[] }>('/api/vps-targets').then((res) => res.targets),
  });
}

export function useCreateVpsTarget() {
  const invalidate = useInvalidateTargets();
  return useMutation({
    mutationFn: (input: VpsTargetInput) =>
      api.post<{ target: VpsTarget }>('/api/vps-targets', input).then((res) => res.target),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

export function useUpdateVpsTarget(id: string) {
  const invalidate = useInvalidateTargets();
  return useMutation({
    mutationFn: (patch: Partial<Omit<VpsTargetInput, 'secret'>> & { secret?: string }) =>
      api.patch<{ target: VpsTarget }>(`/api/vps-targets/${id}`, patch),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

export function useDeleteVpsTarget() {
  const invalidate = useInvalidateTargets();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/vps-targets/${id}`),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

/** POST /api/vps-targets/test — probe an unsaved target (validate before save). */
export function useTestVpsTargetUnsaved() {
  return useMutation({
    mutationFn: (input: VpsTargetInput) => api.post<VpsTestResult>('/api/vps-targets/test', input),
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

/** POST /api/vps-targets/:id/test — probe a saved target by id. */
export function useTestVpsTargetSaved() {
  return useMutation({
    mutationFn: (id: string) => api.post<VpsTestResult>(`/api/vps-targets/${id}/test`),
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}
