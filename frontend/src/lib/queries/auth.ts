/** Current-user session query (GET /api/auth/me). */
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { Me } from '@/lib/api-types';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: Me }>('/api/auth/me').then((res) => res.user),
    // 401 is the expected "logged out" answer — don't retry it.
    retry: false,
    staleTime: 60_000,
  });
}
