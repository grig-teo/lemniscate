// run-task "no changes produced" handling (extracted from agent-run.ts to
// keep that module under the line guard).
//
// Symptom this fixes: some runs ended 'done' after the agent only read
// files — no implementation, no branch push, no PR. The agent loop reports
// success but the worktree is clean (hermes silently dying mid-task, an LLM
// reply that ran out of output budget, a provider that answered with text
// but never called a tool), and the old code marked that a successful
// 'done'. Nothing retried it and the user saw a green task with zero
// deliverable.
//
// New outcome for a no-changes run without an open PR:
//   1. Attempts 1..N-1 → requeue the task and enqueue ONE immediate retry
//      with a stronger prompt (implementTask returns null, so the same
//      executeRunTask pass opens no PR and performs no further push).
//   2. Final attempt → 'failed' with a clear error so the user sees what
//      happened and can rerun manually — 'done' is now reserved for runs
//      that actually produced something (or a merged PR).

import { logEvent } from './agent-git.js';
import { loadTaskWithRepo, type LlmRuntime, type TaskWithRepo } from './agent-runtime.js';
import { TaskErrorCode } from './errors.js';
import { logger } from './logger.js';
import { enqueueRunTask } from './proposal-scheduler.js';
import { prisma } from './prisma.js';
import { claimTaskForRun } from './task-claim.js';
import { setTaskStatus } from './task-events.js';
import { sleep } from './utils.js';

// Outcome of one executeRunTask pass: the pipeline ended in a final status,
// or the run produced no changes and requeued itself for one more attempt
// (the retried delivery runs executeRunTask again).
export type RunOutcome = 'final' | 'retry';

// One automatic retry per no-changes run (2 attempts total) — bounded so a
// repo where the agent legitimately finds nothing to do cannot loop
// forever. A rerun may only happen while the task is still 'queued' (the
// requeue below), so a user cancelling between attempts wins.
export const NO_CHANGE_MAX_ATTEMPTS = 2;

// Small pause between the claim and the implementation attempt so a retry
// job that lost its requeue (cancelled in between, or already re-claimed)
// stands down before doing any work.
const REQUEUE_SETTLE_MS = 2_000;

const NO_CHANGE_FAILURE_MESSAGE =
  'The agent finished without making any changes (no edits, nothing to commit, no pull request opened).';

export class NoChangesProducedError extends Error {
  constructor(public readonly attempts: number) {
    super(`${NO_CHANGE_FAILURE_MESSAGE} Giving up after ${attempts} attempt(s).`);
    this.name = 'NoChangesProducedError';
  }
}

async function requeueForRetry(taskId: string, attempt: number): Promise<void> {
  await logEvent(
    taskId,
    `no changes produced (attempt ${attempt}/${NO_CHANGE_MAX_ATTEMPTS}); retrying with a stronger prompt`,
  );
  await setTaskStatus(taskId, 'queued');
  await enqueueRunTask(taskId);
}

async function failNoChanges(taskId: string, attempt: number): Promise<never> {
  await logEvent(
    taskId,
    `no changes produced (attempt ${attempt}/${NO_CHANGE_MAX_ATTEMPTS}); marking the task failed`,
  );
  await prisma.task.update({ where: { id: taskId }, data: { changedPaths: [] } });
  await setTaskStatus(taskId, 'failed', {
    error: `${NO_CHANGE_FAILURE_MESSAGE} The task was retried ${attempt - 1} time(s); check the task console and rerun it (a stronger model or a more specific prompt usually helps).`,
    errorCode: TaskErrorCode.UNKNOWN,
  });
  throw new NoChangesProducedError(attempt);
}

// Routes a no-changes run: retry while attempts remain, fail on the last
// one. Always resolves to 'retry' or throws — never returns 'done'.
export async function handleNoChangesProduced(taskId: string, attempt: number): Promise<'retry'> {
  if (attempt < NO_CHANGE_MAX_ATTEMPTS) {
    await requeueForRetry(taskId, attempt);
    return 'retry';
  }
  await failNoChanges(taskId, attempt);
  // Unreachable — failNoChanges throws — but tsc does not narrow a
  // Promise<never> through an awaited call, so keep the ending explicit.
  throw new NoChangesProducedError(attempt);
}

// Claim gate for a retry delivery: the requeued task must still be in a
// claimable state after a short settle window. Returns false when the task
// was cancelled or already picked up elsewhere — the caller must then stand
// down without touching the workdir.
export async function taskStillClaimable(taskId: string, claimable: readonly string[]): Promise<boolean> {
  await sleep(REQUEUE_SETTLE_MS);
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true },
  });
  return task !== null && claimable.includes(task.status);
}

// Result of one executeRunTask pass: the runtime (so the caller can persist
// cumulative token usage) plus the outcome.
export interface RunAttemptResult {
  rt: LlmRuntime;
  outcome: RunOutcome;
}

// One-attempt loop extracted from runTask. `runAttempt` performs one full
// pass (clone/resume → implement → push → PR); a no-changes pass requeues
// itself with a stronger prompt and returns 'retry', in which case the loop
// reclaims the task and tries again — handleNoChangesProduced throws
// NoChangesProducedError on the final attempt, so the loop cannot spin
// forever. Returns null (with the runtime so far) when the run stood down:
// the requeue was lost to a cancel or won by a duplicate executor, so the
// task is NOT finished and the caller must skip the completion hook.
export async function runWithNoChangeRetries(
  taskId: string,
  initialTask: TaskWithRepo,
  claimable: readonly string[],
  runAttempt: (task: TaskWithRepo, attempt: number) => Promise<RunAttemptResult>,
): Promise<{ rt: LlmRuntime; stoodDown: boolean }> {
  let task = initialTask;
  for (let attempt = 1; ; attempt++) {
    const { rt, outcome } = await runAttempt(task, attempt);
    if (outcome === 'final') return { rt, stoodDown: false };
    if (!(await taskStillClaimable(taskId, claimable))) {
      logger.info(
        { taskId },
        'run-task: retry requeue lost (cancelled or claimed), standing down',
      );
      return { rt, stoodDown: true };
    }
    if (!(await claimTaskForRun(taskId))) return { rt, stoodDown: true };
    // Refresh so the next attempt sees the current prompt/branch/prUrl.
    const fresh = await loadTaskWithRepo(taskId);
    if (fresh) task = fresh;
  }
}
