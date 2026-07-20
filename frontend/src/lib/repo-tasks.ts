import type { Task } from '@/lib/hooks';

/** How many fresh proposals a repo should keep in stock — shown as the "n/5" badge. */
export const PROPOSAL_TARGET_COUNT = 5;

/** Tasks-query poll cadence while a repo is short of fresh proposals. */
export const PROPOSAL_POLL_INTERVAL_MS = 10_000;

export interface SplitRepoTasks {
  proposals: Task[];
  processes: Task[];
}

/** A proposal task that has not been started yet (the only startable kind). */
export function isPendingProposal(task: { kind?: string; status: string }): boolean {
  return task.kind === 'proposal' && task.status === 'pending';
}

/** Split a repo's tasks into fresh proposals and everything else, order preserved. */
export function splitRepoTasks(tasks: Task[]): SplitRepoTasks {
  return {
    proposals: tasks.filter(isPendingProposal),
    processes: tasks.filter((task) => !isPendingProposal(task)),
  };
}

/**
 * Refetch interval for a repo's tasks query: poll while generation may be in
 * flight (pending proposals below target), stop once the repo is stocked.
 */
export function proposalPollInterval(tasks: Task[] | undefined): number | false {
  const pending = (tasks ?? []).filter(isPendingProposal).length;
  if (pending >= PROPOSAL_TARGET_COUNT) return false;
  return PROPOSAL_POLL_INTERVAL_MS;
}
