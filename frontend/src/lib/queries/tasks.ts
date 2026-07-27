/** Task queries and mutations (GET/POST /api/tasks…). */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { CreateTaskBody, StartTaskBody, Task } from '@/lib/api-types';
// Mutations whose callers already render the error inline (dialogs, settings
// forms) opt out of the global MutationCache error toast with this meta.
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';
import { useMe } from '@/lib/queries/auth';
import { useInvalidator } from '@/lib/queries/invalidate';
import type { TaskRunTarget } from '@/lib/queries/devices';
import { activityPollInterval, hasActiveProcesses } from '@/lib/running-tasks';

function tasksPath(repositoryId: string | null | undefined, archived?: boolean): string {
  const params = new URLSearchParams();
  if (repositoryId) params.set('repositoryId', repositoryId);
  if (archived) params.set('archived', 'true');
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return `/api/tasks${suffix}`;
}

/** Tasks for one repository, or all of the user's tasks (cap 100) when no id is given. */
export function useTasks(
  repositoryId?: string | null,
  options?: {
    refetchInterval?: UseQueryOptions<Task[]>['refetchInterval'];
    /** Fetch ONLY archived tasks instead of the default active ones. */
    archived?: boolean;
    enabled?: boolean;
  },
) {
  return useQuery({
    queryKey: ['tasks', repositoryId ?? null, options?.archived ? 'archived' : 'active'],
    queryFn: () =>
      api.get<{ tasks: Task[] }>(tasksPath(repositoryId, options?.archived)).then((res) => res.tasks),
    refetchInterval: options?.refetchInterval,
    enabled: options?.enabled,
  });
}

/** One task by id, including the full prompt; disabled until an id is set. */
export function useTask(
  id: string | null | undefined,
  options?: { refetchInterval?: UseQueryOptions<Task>['refetchInterval'] },
) {
  return useQuery({
    queryKey: ['task', id ?? null],
    queryFn: () => api.get<{ task: Task }>(`/api/tasks/${id}`).then((res) => res.task),
    enabled: Boolean(id),
    refetchInterval: options?.refetchInterval,
  });
}

/**
 * True while any of the user's tasks is running, reviewing code, or awaiting
 * review — drives the animated brand mark and favicon. The shared
 * ['tasks', null, 'active'] list is only fetched for authenticated visitors
 * (so the public landing page stays 401-free) and polls while anything is in
 * flight or active so the animation starts/stops in sync with task transitions.
 */
export function useHasActiveProcesses(): boolean {
  const me = useMe();
  const tasks = useTasks(null, {
    enabled: Boolean(me.data),
    refetchInterval: (query) => activityPollInterval(query.state.data as Task[] | undefined),
  });
  return hasActiveProcesses(tasks.data);
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
    meta: SUPPRESS_ERROR_TOAST_META, // TaskComposer renders isError inline
  });
}

/** POST /api/tasks/:id/start — queue a pending proposal for implementation. */
export function useStartTask() {
  const invalidate = useInvalidator(['tasks'], ['task']);
  return useMutation({
    mutationFn: (args: string | { id: string; body?: StartTaskBody }) => {
      const { id, body } = typeof args === 'string' ? { id: args, body: undefined } : args;
      return api.post<unknown>(`/api/tasks/${id}/start`, body);
    },
    onSuccess: invalidate,
  });
}

export type ImproveTaskBody = { title?: string; prompt: string };

/** POST /api/tasks/:id/improve — LLM-improved task description (not persisted). */
export function useImproveTask() {
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ImproveTaskBody }) =>
      api.post<{ prompt: string }>(`/api/tasks/${id}/improve`, body),
    meta: SUPPRESS_ERROR_TOAST_META, // ProposalDetail renders the error inline
  });
}

/**
 * The one "POST /api/tasks/:id/<action> then invalidate the task lists"
 * mutation (AGENTS.md section 6) — rerun/cancel/archive/unarchive differ
 * only in the action segment.
 */
function useTaskAction(action: 'rerun' | 'cancel' | 'archive' | 'unarchive' | 'close-pr') {
  const invalidate = useInvalidator(['tasks'], ['task']);
  return useMutation({
    mutationFn: (id: string) => api.post<unknown>(`/api/tasks/${id}/${action}`),
    onSuccess: invalidate,
  });
}

/** Re-queue a failed or closed task with fresh run state. */
export function useRerunTask() {
  return useTaskAction('rerun');
}

/** Stop a pending/queued/running task. */
export function useCancelTask() {
  return useTaskAction('cancel');
}

/** Close a PR and delete its branch from the UI (awaiting_review tasks only). */
export function useClosePrTask() {
  return useTaskAction('close-pr');
}

/** Hide a task from the task lists. */
export function useArchiveTask() {
  return useTaskAction('archive');
}

/** Bring an archived task back to the task lists. */
export function useUnarchiveTask() {
  return useTaskAction('unarchive');
}

/**
 * GET /api/tasks/:id/run-targets — run targets affected by a finished task.
 * Targets with zero devices are included (the UI greys them out).
 */
export function useTaskRunTargets(taskId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['task-run-targets', taskId ?? null],
    queryFn: () =>
      api
        .get<{ targets: TaskRunTarget[] }>(`/api/tasks/${taskId}/run-targets`)
        .then((res) => res.targets),
    enabled: Boolean(taskId) && enabled,
    refetchInterval: 30_000,
  });
}
