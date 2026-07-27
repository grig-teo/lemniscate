import type { Repository, Task } from '@/lib/hooks';

/** Statuses shown in the landing "Running processes" section. */
const RUNNING_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'reviewing_code']);

/** A task in flight — queued or running. */
export function isRunningStatus(status: string): boolean {
  return RUNNING_STATUSES.has(status);
}

/**
 * Statuses that count as "active work in progress": the brand mark and tab
 * icon animate while any task is running or awaiting review (in review).
 * Idle states (pending, done, …) and "queued" (dispatched but not yet
 * running) do NOT animate.
 */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['running', 'reviewing_code', 'awaiting_review']);

/** True for statuses that mean work is actively in progress (animate). */
export function isActiveProcessStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** Tasks-query poll cadence while any task is queued or running. */
export const IN_FLIGHT_POLL_INTERVAL_MS = 5_000;

/** True while any task is queued or running. */
export function hasInFlightTasks(tasks: Task[] | undefined): boolean {
  return (tasks ?? []).some((task) => isRunningStatus(task.status));
}

/** True while any task is running or awaiting review (active work → animate). */
export function hasActiveProcesses(tasks: Task[] | undefined): boolean {
  return (tasks ?? []).some((task) => isActiveProcessStatus(task.status));
}

/**
 * Refetch interval for a tasks list: poll while any task is in flight so
 * status badges converge even without SSE (task not selected), stop once
 * everything reached a terminal state.
 */
export function inFlightPollInterval(tasks: Task[] | undefined): number | false {
  return hasInFlightTasks(tasks) ? IN_FLIGHT_POLL_INTERVAL_MS : false;
}

/**
 * Refetch interval for activity indicators (brand mark / favicon): keep
 * polling while anything is in flight OR actively running/awaiting review so
 * the animation starts and stops in sync with task transitions. Returns false
 * (no polling) once every task is idle.
 */
export function activityPollInterval(tasks: Task[] | undefined): number | false {
  return hasInFlightTasks(tasks) || hasActiveProcesses(tasks) ? IN_FLIGHT_POLL_INTERVAL_MS : false;
}

export interface RepositoryTaskGroup {
  repositoryName: string;
  tasks: Task[];
}

/** Tasks currently in flight (queued or running), order preserved. */
export function selectRunningTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => isRunningStatus(task.status));
}

/**
 * Group tasks under their repository display name, preserving task order.
 * Tasks whose repository is not in the list fall back to "Unknown repository".
 */
export function groupTasksByRepository(
  tasks: Task[],
  repositories: Repository[],
): RepositoryTaskGroup[] {
  const nameById = new Map(repositories.map((repo) => [repo.id, repo.name]));
  const groups = new Map<string, RepositoryTaskGroup>();
  for (const task of tasks) {
    const key = nameById.has(task.repositoryId) ? task.repositoryId : '';
    const group = groups.get(key) ?? {
      repositoryName: nameById.get(task.repositoryId) ?? 'Unknown repository',
      tasks: [],
    };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()];
}
