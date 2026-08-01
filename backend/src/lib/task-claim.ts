import { logger } from './logger.js';
import { prisma } from './prisma.js';

// Atomic exactly-once claim for the 'run-task' job.
//
// Duplicate delivery is possible twice over: a double-enqueue that slipped
// past BullMQ jobId dedupe (jobId only dedupes while the job is retained),
// and BullMQ re-delivering a job it marked stalled while the original
// handler still runs. Both executions would share AGENT_WORKDIR/<taskId> —
// one run's cleanup deletes the other's clone mid-flight and both can push
// the same branch and open duplicate PRs. The conditional updateMany below
// is the durable guard: exactly one executor flips the task to 'running',
// every concurrent loser matches 0 rows and stands down.

// Statuses a run may be claimed from. 'queued' is the normal path — every
// enqueue site (create/start/rerun/recovery) flips the task to 'queued'
// before enqueueing; 'pending' is tolerated defensively (saved-for-later
// tasks enqueued by an older deploy). 'running' is deliberately absent: it
// means another executor owns the run — recovery paths for dead runs
// (recoverInterruptedTasks, recoverStuckReviews) reset to 'queued' first.
export const RUN_CLAIMABLE_STATUSES = ['queued', 'pending'] as const;

// Claims the task for this executor. Returns true when the claim was won;
// false (with a log line) when another executor already owns the run or the
// task left the claimable states — the caller must return without touching
// the workdir, the branch, or the PR.
export async function claimTaskForRun(taskId: string): Promise<boolean> {
  const claimed = await prisma.task.updateMany({
    where: { id: taskId, status: { in: [...RUN_CLAIMABLE_STATUSES] } },
    data: { status: 'running' },
  });
  if (claimed.count === 0) {
    logger.info({ taskId }, 'run-task: task already claimed by another executor, skipping');
    return false;
  }
  return true;
}
