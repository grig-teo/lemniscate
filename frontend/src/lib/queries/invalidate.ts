/**
 * The single home of the "invalidate these keys after a mutation" pattern
 * (AGENTS.md section 6 — one parameterized function beats N copies).
 * Domain modules pass the keys their mutations must invalidate.
 */
import { useQueryClient, type QueryKey } from '@tanstack/react-query';

/** Callback that invalidates each given query key, for mutation handlers. */
export function useInvalidator(...keys: QueryKey[]) {
  const queryClient = useQueryClient();
  return () => {
    for (const key of keys) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}
