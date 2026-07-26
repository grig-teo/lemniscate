/**
 * Global mutation error reporting: a single `MutationCache` `onError` handler
 * (wired in `main.tsx`) that turns every failed mutation into a toast with
 * the human-readable `describeApiError` text — no per-component wiring.
 *
 * Mutations that already render their own error inline (dialogs, settings
 * sections, …) opt out by setting `meta: { suppressErrorToast: true }` so
 * the same failure is not reported twice.
 */
import type { Mutation } from '@tanstack/react-query';

import { describeApiError } from '@/lib/api';
import { pushToast } from '@/lib/toasts';

type AnyMutation = Mutation<unknown, unknown, unknown, unknown>;

/**
 * Mutation `meta` opting out of the global error toast — for mutations whose
 * error is already rendered inline by their caller (dialogs, settings forms).
 */
export const SUPPRESS_ERROR_TOAST_META = { suppressErrorToast: true } as const;

/** True unless the mutation opted out of the global error toast. */
export function shouldToastMutationError(mutation: AnyMutation): boolean {
  return mutation.meta?.suppressErrorToast !== true;
}

/** MutationCache `onError` signature: (error, variables, context, mutation). */
export function reportMutationError(
  error: unknown,
  _variables: unknown,
  _context: unknown,
  mutation: AnyMutation,
): void {
  if (!(error instanceof Error)) return;
  if (!shouldToastMutationError(mutation)) return;
  pushToast(describeApiError(error));
}
