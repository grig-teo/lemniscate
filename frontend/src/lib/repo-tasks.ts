import type { Task } from '@/lib/hooks';
import type { SelectedTask } from '@/lib/selection';

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

/** Repo-tree rows show the status badge only for started tasks — unstarted
 *  proposals/prompts sit under group labels that already say "pending". */
export function showsStatusBadge(task: { kind?: string; status: string }): boolean {
  return !isStartableTask(task);
}

/** Tasks the user can archive — anything not actively in flight
 *  (mirrors the backend UNARCHIVABLE_STATUSES). */
export function isArchivable(status: string): boolean {
  return status !== 'running' && status !== 'queued' && status !== 'reviewing_code';
}

/** Tasks the user can rerun — failed (including user-cancelled) and closed
 *  (PR closed without merge), mirroring the backend rerunBlocker. */
export function isRerunnable(status: string): boolean {
  return status === 'failed' || status === 'closed';
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

/** Task → the lean selection snapshot stored by the workspace selection. */
export function toSelectedTask(task: Task): SelectedTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    kind: task.kind,
    repositoryId: task.repositoryId,
    branchName: task.branchName ?? null,
    prUrl: task.prUrl ?? null,
  };
}

/** Statuses that mean a PR exists on the git host for this task. */
const PR_STATUSES = new Set(['awaiting_review', 'reviewing_code', 'done', 'closed']);

/** True when a task has an open or merged PR (a branch was pushed). */
export function hasPullRequest(task: Task): boolean {
  return Boolean(task.branchName) && PR_STATUSES.has(task.status);
}

/** Filter a task list to only PR tasks, most recent first. */
export function selectPrTasks(tasks: Task[]): Task[] {
  return tasks.filter(hasPullRequest).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
