/** LLM token usage + estimated cost report (GET /api/usage). */
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { UsagePeriod, UsageReport } from '@/lib/api-types';

/** LLM token usage + estimated cost for the settings Usage panel. */
export function useUsage(period: UsagePeriod) {
  return useQuery({
    queryKey: ['usage', period],
    queryFn: () => api.get<UsageReport>(`/api/usage?period=${period}`),
    staleTime: 30_000,
  });
}
