/** Gitlem (internal git host) auth + account-provisioning mutations. */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';

// Gitlem login/register create a lemniscate session (Set-Cookie) and link a
// gitlem GitConnection; the SPA cache for me/connections/repos is stale until
// these are invalidated. Callers render errors inline (the connect page, the
// settings section), so the global error toast is suppressed.
function useInvalidateAfterSession() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['me'] }),
      queryClient.invalidateQueries({ queryKey: ['connections'] }),
      queryClient.invalidateQueries({ queryKey: ['repositories'] }),
    ]);
}

/** POST /api/gitlem/login — email + password; sets the session cookie. */
export function useGitlemLogin() {
  const invalidate = useInvalidateAfterSession();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      api.post<{ ok: true }>('/api/gitlem/login', body),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

/** POST /api/gitlem/register/code — send a 6-digit registration code. */
export function useGitlemRequestCode() {
  return useMutation({
    mutationFn: (body: { email: string }) =>
      api.post<{ ok: true }>('/api/gitlem/register/code', body),
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

/** POST /api/gitlem/register — verify the code; password optional (auto-emailed). */
export function useGitlemRegister() {
  const invalidate = useInvalidateAfterSession();
  return useMutation({
    mutationFn: (body: { email: string; code: string; password?: string }) =>
      api.post<{ ok: true }>('/api/gitlem/register', body),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}

/**
 * POST /api/gitlem/ensure — lazily provision a gitlem account for the signed-in
 * user (checks first; only creates when none exists). Used by the settings tab
 * and the gitlem repos grid "+" affordance. Returns created/username/emailed.
 */
export function useEnsureGitlemAccount() {
  const invalidate = useInvalidateAfterSession();
  return useMutation({
    mutationFn: () =>
      api.post<{ created: boolean; username: string; emailed: boolean }>('/api/gitlem/ensure'),
    onSuccess: invalidate,
    meta: SUPPRESS_ERROR_TOAST_META,
  });
}
