/**
 * Single source of truth for the task implementation steps shown on the
 * right-edge rail (components/TaskStepsRail.tsx): the ordered lifecycle
 * steps plus the per-step tone derived from a task status. Pure module —
 * no React, no storage.
 */

export interface TaskStep {
  /** Task status this step corresponds to. */
  status: string;
  /** Human-readable vertical label. */
  label: string;
}

/** Ordered implementation steps of a task, from proposal to merged PR. */
export const TASK_STEPS: readonly TaskStep[] = [
  { status: 'pending', label: 'Proposal' },
  { status: 'queued', label: 'Queued' },
  { status: 'running', label: 'Running' },
  { status: 'reviewing_code', label: 'Code review' },
  { status: 'awaiting_review', label: 'PR review' },
  { status: 'done', label: 'Done' },
];

/** Visual state of one step for the currently selected task. */
export type StepTone = 'complete' | 'current' | 'upcoming' | 'failed';

// Terminal failure statuses anchor on the step they most likely died at:
// a failed run dies while running; a closed task had its PR closed.
const FAILED_ANCHOR: Record<string, string> = {
  failed: 'running',
  closed: 'awaiting_review',
};

/** Index of a lifecycle status in TASK_STEPS; -1 for anything unknown. */
export function stepIndexForStatus(status: string): number {
  return TASK_STEPS.findIndex((step) => step.status === status);
}

/** Tone of the step at `stepIndex` given the task's current status. */
export function stepTone(stepIndex: number, status: string): StepTone {
  const anchor = FAILED_ANCHOR[status];
  if (anchor) return failedTone(stepIndex, stepIndexForStatus(anchor));
  // A merged task has completed every step, including the final "done" one.
  if (status === 'done') return 'complete';
  const current = stepIndexForStatus(status);
  if (current < 0) return 'upcoming';
  if (stepIndex < current) return 'complete';
  if (stepIndex === current) return 'current';
  return 'upcoming';
}

/** Tone relative to the failed anchor step. */
function failedTone(stepIndex: number, anchorIndex: number): StepTone {
  if (stepIndex < anchorIndex) return 'complete';
  if (stepIndex === anchorIndex) return 'failed';
  return 'upcoming';
}
