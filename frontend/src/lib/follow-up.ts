import type { Task } from './task-types';

// Follow-up dropdown candidate rule (single home per AGENTS.md §6): every
// task in the repository is listed — proposals/prompts (pending), queued,
// running, in review, code review, done, failed, closed — EXCEPT archived
// tasks (the default active list already omits them, but a task archived
// while still linked must not linger as an invisible selection) and the
// predecessor itself (a task cannot follow itself).
// Note: triggerNextTask only auto-starts successors that are still idle
// (pending/queued) at firing time; linking a non-idle task is allowed but
// fires only if it is backlogged before the predecessor completes.

/** Human-readable label for a candidate's status in the dropdown. */
export function followUpStatusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

/** Whether `candidate` may be offered as a follow-up successor of `task`. */
export function isFollowUpCandidate(candidate: Task, taskId?: string): boolean {
  if (taskId !== undefined && candidate.id === taskId) return false;
  return candidate.archivedAt === null;
}

/** Follow-up candidates for `taskId` out of a repo's task list. */
export function followUpCandidates(tasks: Task[], taskId?: string): Task[] {
  return tasks.filter((t) => isFollowUpCandidate(t, taskId));
}
