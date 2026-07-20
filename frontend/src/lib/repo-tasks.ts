import type { Task } from '@/lib/hooks';

/** How many fresh proposals a repo should keep in stock — shown as the "n/5" badge. */
export const PROPOSAL_TARGET_COUNT = 5;

export interface SplitRepoTasks {
  proposals: Task[];
  processes: Task[];
}

/** A proposal task that has not been started yet (the only startable kind). */
export function isPendingProposal(task: Task): boolean {
  return task.kind === 'proposal' && task.status === 'pending';
}

/** Split a repo's tasks into fresh proposals and everything else, order preserved. */
export function splitRepoTasks(tasks: Task[]): SplitRepoTasks {
  return {
    proposals: tasks.filter(isPendingProposal),
    processes: tasks.filter((task) => !isPendingProposal(task)),
  };
}
