/**
 * Temporary re-export barrel for the TanStack Query data layer (one release,
 * so import sites need not change in the same PR). The API contract types
 * live in lib/api-types.ts; the hooks live in per-domain modules under
 * lib/queries/ (auth, connections, llm-configs, repositories, tasks, usage,
 * skills, devices, services). New hooks go to their domain module, not here.
 */
export { API_BASE_URL } from '@/lib/api';
export * from '@/lib/api-types';
export * from '@/lib/queries/auth';
export * from '@/lib/queries/connections';
export * from '@/lib/queries/llm-configs';
export * from '@/lib/queries/notification-channels';
export * from '@/lib/queries/repositories';
export * from '@/lib/queries/settings';
export * from '@/lib/queries/tasks';
export * from '@/lib/queries/usage';
export * from '@/lib/queries/skills';
export * from '@/lib/queries/devices';
export * from '@/lib/queries/event-triggers';
export * from '@/lib/queries/services';
export * from '@/lib/queries/vps-targets';
