/** Services domain (Lemniscate Apps): queries and mutations under /api/services. */
import { useMutation, useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
// Mutations whose callers already render the error inline (dialogs, settings
// forms) opt out of the global MutationCache error toast with this meta.
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';
import { useInvalidator } from '@/lib/queries/invalidate';
import type { AppService, ServiceDeployment } from '@/lib/services';

function useInvalidateServices() {
  return useInvalidator(['services']);
}

/** GET /api/services — polled: statuses flip while deploys run. */
export function useServices() {
  return useQuery({
    queryKey: ['services'],
    queryFn: () => api.get<{ services: AppService[] }>('/api/services').then((res) => res.services),
    refetchInterval: 5_000,
  });
}

export function useCreateService() {
  const invalidate = useInvalidateServices();
  return useMutation({
    mutationFn: (input: { repositoryId: string; name?: string; port?: number; autoDeploy?: boolean }) =>
      api.post<{ service: AppService }>('/api/services', input).then((res) => res.service),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // CreateServiceDialog renders the error inline
  });
}

export function useUpdateService(serviceId: string) {
  const invalidate = useInvalidateServices();
  return useMutation({
    mutationFn: (patch: { name?: string; port?: number; autoDeploy?: boolean }) =>
      api.patch<{ service: AppService }>(`/api/services/${serviceId}`, patch),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // ServiceDetail renders the error inline
  });
}

export function useDeleteService() {
  const invalidate = useInvalidateServices();
  return useMutation({
    mutationFn: (serviceId: string) => api.del(`/api/services/${serviceId}`),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // ServiceDetail renders the error inline
  });
}

export function useDeployService() {
  const invalidate = useInvalidateServices();
  return useMutation({
    mutationFn: (serviceId: string) =>
      api.post<{ deployment: ServiceDeployment }>(`/api/services/${serviceId}/deploy`),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // ServiceDetail renders the error inline
  });
}

export function useStopService() {
  const invalidate = useInvalidateServices();
  return useMutation({
    mutationFn: (serviceId: string) => api.post(`/api/services/${serviceId}/stop`),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // ServiceDetail renders the error inline
  });
}

/** GET /api/services/:id/deployments — last 20, polled while any is active. */
export function useServiceDeployments(serviceId: string | null) {
  return useQuery({
    queryKey: ['service-deployments', serviceId],
    enabled: serviceId !== null,
    queryFn: () =>
      api
        .get<{ deployments: ServiceDeployment[] }>(`/api/services/${serviceId}/deployments`)
        .then((res) => res.deployments),
    refetchInterval: 5_000,
  });
}

/** POST body for the env merge endpoint: set adds/replaces, remove deletes. */
export interface ServiceEnvPatch {
  set: Record<string, string>;
  remove: string[];
}

export function useSaveServiceEnv(serviceId: string) {
  const invalidate = useInvalidateServices();
  return useMutation({
    mutationFn: (patch: ServiceEnvPatch) =>
      api.put<{ keys: string[] }>(`/api/services/${serviceId}/env`, { ...patch }),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META, // ServiceDetail renders the error inline
  });
}

/** Live container logs, fetched on demand (enabled flag). */
export function useServiceLogs(serviceId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['service-logs', serviceId],
    enabled: enabled && serviceId !== null,
    queryFn: () => api.get<{ log: string }>(`/api/services/${serviceId}/logs`).then((res) => res.log),
  });
}
