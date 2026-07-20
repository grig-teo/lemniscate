/**
 * TanStack Query hooks for the Lemniscate backend API — the single data
 * layer shared by the settings dialog, the login page, and the shell panes
 * (RepoTree / ConsolePane). All shapes mirror the backend API
 * contract — payloads are camelCase and LLM configs never include `apiKey`
 * in responses (`hasApiKey` flags whether one is stored).
 */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';

import { api } from '@/lib/api';

/** Base URL for non-fetch clients (EventSource) — canonical source is lib/api.ts. */
export { API_BASE_URL } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types (API contract)
// ---------------------------------------------------------------------------

export type Me = {
  id: string;
  createdAt: string;
};

export type GitProvider = 'github' | 'gitlab' | 'gitverse';

export type Connection = {
  id: string;
  provider: GitProvider;
  username: string;
  baseUrl: string | null;
};

export type ConnectionPayload = {
  provider: GitProvider;
  token: string;
  baseUrl?: string;
};

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** LLM config as returned by the API — `apiKey` is never included. */
export type LlmConfig = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  thinkingLevel: ThinkingLevel;
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  systemPromptExtra: string | null;
  timeoutSeconds: number;
  maxRetries: number;
  requestsPerMinute: number;
  maxTokensPerRun: number;
  customHeaders: Record<string, string> | null;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Create/update payload; unset optional fields fall back to server defaults. */
export type LlmConfigPayload = {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  systemPromptExtra?: string;
  timeoutSeconds?: number;
  maxRetries?: number;
  requestsPerMinute?: number;
  maxTokensPerRun?: number;
  customHeaders?: Record<string, string>;
  isDefault?: boolean;
  enabled?: boolean;
};

export type LlmTestResult = {
  ok: boolean;
  latencyMs?: number;
  modelEcho?: string;
  reply?: string;
  error?: string;
};

export type Repository = {
  id: string;
  connectionId: string;
  externalId: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  autoPropose: boolean;
  autoCreatePr: boolean;
  autoReviewPr: boolean;
  autoMergePr: boolean;
  hidden: boolean;
  llmConfigId?: string | null;
  connection: {
    provider: GitProvider;
    username: string;
  };
};

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'done'
  | 'failed'
  | (string & {});

/** Per-task thinking-level override accepted by POST /api/tasks. */
export type TaskThinkingLevel = 'low' | 'medium' | 'high' | 'max';

/** Image attachment sent with a prompt task (data URL, max 3 per task). */
export type TaskImage = {
  name: string;
  dataUrl: string;
};

export type Task = {
  id: string;
  repositoryId: string;
  kind: string;
  title: string;
  status: TaskStatus;
  /** Full prompt — only included by GET /api/tasks/:id, not by list endpoints. */
  prompt?: string;
  branchName?: string | null;
  prUrl?: string | null;
  thinkingLevel?: TaskThinkingLevel | null;
  attachments?: TaskImage[] | null;
  createdAt: string;
  updatedAt: string;
};

/** POST /api/tasks body; optional fields are omitted when unset. */
export type CreateTaskBody = {
  repositoryId: string;
  prompt: string;
  thinkingLevel?: TaskThinkingLevel;
  images?: TaskImage[];
};

/** POST /api/tasks/:id/start body — proposal edits applied before queueing. */
export type StartTaskBody = {
  title?: string;
  prompt?: string;
  images?: TaskImage[];
};

export type TaskEventKind = 'log' | 'diff' | 'status' | (string & {});

export type TaskEventItem = {
  id: string;
  kind: TaskEventKind;
  payload: unknown;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: Me }>('/api/auth/me').then((res) => res.user),
    // 401 is the expected "logged out" answer — don't retry it.
    retry: false,
    staleTime: 60_000,
  });
}

export function useConnections() {
  return useQuery({
    queryKey: ['connections'],
    queryFn: () =>
      api.get<{ connections: Connection[] }>('/api/connections').then((res) => res.connections),
  });
}

export function useLlmConfigs() {
  return useQuery({
    queryKey: ['llm-configs'],
    queryFn: () =>
      api.get<{ configs: LlmConfig[] }>('/api/llm-configs').then((res) => res.configs),
  });
}

export function useRepositories() {
  return useQuery({
    queryKey: ['repositories'],
    queryFn: () =>
      api.get<{ repositories: Repository[] }>('/api/repositories').then((res) => res.repositories),
  });
}

function tasksPath(repositoryId: string | null | undefined): string {
  if (!repositoryId) return '/api/tasks';
  return `/api/tasks?repositoryId=${encodeURIComponent(repositoryId)}`;
}

/** Tasks for one repository, or all of the user's tasks (cap 100) when no id is given. */
export function useTasks(
  repositoryId?: string | null,
  options?: { refetchInterval?: UseQueryOptions<Task[]>['refetchInterval'] },
) {
  return useQuery({
    queryKey: ['tasks', repositoryId ?? null],
    queryFn: () => api.get<{ tasks: Task[] }>(tasksPath(repositoryId)).then((res) => res.tasks),
    refetchInterval: options?.refetchInterval,
  });
}

/** One task by id, including the full prompt; disabled until an id is set. */
export function useTask(id: string | null | undefined) {
  return useQuery({
    queryKey: ['task', id ?? null],
    queryFn: () => api.get<{ task: Task }>(`/api/tasks/${id}`).then((res) => res.task),
    enabled: Boolean(id),
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Connections affect the repo list (sync runs server-side on connect). */
function useInvalidateConnections() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['connections'] });
    void queryClient.invalidateQueries({ queryKey: ['repositories'] });
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };
}

export function useCreateConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: (payload: ConnectionPayload) =>
      api
        .post<{ connection: Connection }>('/api/connections', payload)
        .then((res) => res.connection),
    onSuccess: invalidate,
  });
}

export function useDeleteConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/connections/${id}`),
    onSuccess: invalidate,
  });
}

/** POST /api/connections/:id/sync — re-list repositories from the git host. */
export function useSyncConnection() {
  const invalidate = useInvalidateConnections();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ synced: number; created: number; updated: number }>(`/api/connections/${id}/sync`),
    onSettled: invalidate,
  });
}

interface RepoFlagsPatch {
  autoCreatePr?: boolean;
  autoReviewPr?: boolean;
  autoMergePr?: boolean;
}

/** PATCH /api/repositories/:id with an optimistic cache update. */
export function useUpdateRepositoryFlags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: RepoFlagsPatch }) =>
      api
        .patch<{ repository: Repository }>(`/api/repositories/${id}`, { ...patch })
        .then((res) => res.repository),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: ['repositories'] });
      const previous = queryClient.getQueryData<Repository[]>(['repositories']);
      queryClient.setQueryData<Repository[]>(['repositories'], (old) =>
        old?.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo)),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      queryClient.setQueryData(['repositories'], context?.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
    },
  });
}

/** POST /api/repositories/flags — rewrite these flags on ALL repositories. */
export function useUpdateAllRepositoryFlags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (flags: Required<RepoFlagsPatch>) =>
      api.post<{ updated: number }>('/api/repositories/flags', { ...flags }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
    },
  });
}

/** POST /api/tasks — create a prompt task. */
export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskBody) =>
      api.post<{ task: Task }>('/api/tasks', body).then((res) => res.task),
    onSuccess: (_task, { repositoryId }) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', repositoryId] });
    },
  });
}

/** POST /api/tasks/:id/start — queue a pending proposal for implementation. */
export function useStartTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: string | { id: string; body?: StartTaskBody }) => {
      const { id, body } = typeof args === 'string' ? { id: args, body: undefined } : args;
      return api.post<unknown>(`/api/tasks/${id}/start`, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['task'] });
    },
  });
}

/** POST /api/repositories/:id/proposals — enqueue on-demand proposal generation (202). */
export function useGenerateProposals() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<unknown>(`/api/repositories/${id}/proposals`),
    onSettled: (_data, _error, id) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', id] });
    },
  });
}

/** POST /api/tasks/:id/rerun — re-queue a failed task with fresh run state. */
export function useRerunTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<unknown>(`/api/tasks/${id}/rerun`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['task'] });
    },
  });
}

function useInvalidateLlmConfigs() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['llm-configs'] });
  };
}

export function useCreateLlmConfig() {
  const invalidate = useInvalidateLlmConfigs();
  return useMutation({
    mutationFn: (payload: LlmConfigPayload) => api.post<LlmConfig>('/api/llm-configs', payload),
    onSuccess: invalidate,
  });
}

export function useUpdateLlmConfig() {
  const invalidate = useInvalidateLlmConfigs();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: LlmConfigPayload }) =>
      api.patch<LlmConfig>(`/api/llm-configs/${id}`, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteLlmConfig() {
  const invalidate = useInvalidateLlmConfigs();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/llm-configs/${id}`),
    onSuccess: invalidate,
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
  });
}
