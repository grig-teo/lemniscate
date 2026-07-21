import type { Task } from '@/lib/hooks';

/** How many fresh proposals a repo should keep in stock — shown as the "n/5" badge. */
export const PROPOSAL_TARGET_COUNT = 5;

/** Tasks-query poll cadence while a repo is short of fresh proposals. */
export const PROPOSAL_POLL_INTERVAL_MS = 10_000;

export interface RepoTaskGroups {
  proposals: Task[];
  prompts: Task[];
  processes: Task[];
}

/** A proposal task that has not been started yet. */
export function isPendingProposal(task: { kind?: string; status: string }): boolean {
  return task.kind === 'proposal' && task.status === 'pending';
}

/** A prompt task saved for later — startable like a pending proposal. */
export function isPendingPrompt(task: { kind?: string; status: string }): boolean {
  return task.kind === 'prompt' && task.status === 'pending';
}

/** Tasks the user can click-to-start from the repo tree. */
export function isStartableTask(task: { kind?: string; status: string }): boolean {
  return isPendingProposal(task) || isPendingPrompt(task);
}

/** Tasks the user can archive — anything not running or queued (mirrors the backend). */
export function isArchivable(status: string): boolean {
  return status !== 'running' && status !== 'queued';
}

function isProcessTask(task: Task): boolean {
  return !isPendingProposal(task) && !isPendingPrompt(task);
}

/** Split a repo's tasks into proposals, saved-for-later prompts, and processes. */
export function groupRepoTasks(tasks: Task[]): RepoTaskGroups {
  return {
    proposals: tasks.filter(isPendingProposal),
    prompts: tasks.filter(isPendingPrompt),
    processes: tasks.filter(isProcessTask),
  };
}

/** Archived tasks, most recently archived first (null timestamps sort last). */
export function sortByArchivedAtDesc(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));
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
