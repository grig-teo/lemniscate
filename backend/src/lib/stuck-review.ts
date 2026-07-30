import { enqueueReviewTask, getAgentTasksQueue } from './proposal-scheduler.js';
import { logEvent } from './agent-git.js';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

// Stuck-review recovery (home moved out of pr-state-sync.ts to stay under the
// 300-line guard — AGENTS.md §5). Two detection paths:
//
// 1. Error fast path: a review job that exhausted its BullMQ attempts ends
//    with an 'error:' log line (the job itself is gone via removeOnFail).
// 2. Time-based path: a review can also die SILENTLY — no 'error:' line at
//    all (agent finished without a verdict on an old build, worker redeploy
//    wiping the in-memory job, crashed process). Then the task just sits in
//    reviewing_code/awaiting_review forever. If nothing has happened for
//    STUCK_REVIEW_STALE_MS and no job for the task lives in the queue, the
//    review is re-enqueued.
//
// Both paths are bounded per task (MAX_REVIEW_RECOVERIES) so a persistently
// failing endpoint cannot burn tokens in an infinite review loop.

const MAX_REVIEW_RECOVERIES = 3;
const REVIEW_RECOVERY_LOG = 'recovery: re-enqueued PR review after a failed review job';
// Housekeeping logs (e.g. "cleaned up workdir") fire AFTER the error line and
// mask it from a last-line-only check. Scan a small window of recent logs so
// the error that caused the review job to die is still visible.
const STUCK_REVIEW_LOG_SCAN = 5;
// A review with no log/agent_step activity for this long is presumed dead
// unless a job for it is still waiting/active in the queue.
const STUCK_REVIEW_STALE_MS = 30 * 60 * 1000;

// A review that concluded normally ends with one of these lines: either a
// human gate (manual merge/review — no job will ever run again for it) or a
// follow-up job was queued (merge gate / re-review). Neither is stuck, even
// when an older 'error:' line is still inside the scan window.
const CONCLUDED_REVIEW_MARKERS = [
  'approved by LLM, awaiting manual merge',
  'changes still requested, awaiting manual review',
  'queued the merge gate',
  'queued re-review of the updated pull request',
];

function logLine(entry: { payload: unknown }): string | null {
  const line = (entry.payload as { line?: unknown } | null)?.line;
  return typeof line === 'string' ? line : null;
}

// Any live job for this task (review / merge gate / address-review — every
// task-scoped jobId embeds the task id). A live job means the pipeline is
// still moving and recovery must not double-fire. Queue inspection failures
// fail safe: treat the job as present (skip recovery), retry next poll.
async function hasLiveJobForTask(taskId: string): Promise<boolean> {
  try {
    const jobs = await getAgentTasksQueue().getJobs(['active', 'waiting', 'delayed']);
    return jobs.some((job) => typeof job.id === 'string' && job.id.includes(taskId));
  } catch (err) {
    logger.warn({ taskId, err }, 'stuck-review: queue inspection failed, skipping recovery');
    return true;
  }
}

async function isReviewStuck(taskId: string, taskUpdatedAt: Date | null): Promise<boolean> {
  const recoveries = await prisma.taskEvent.count({
    where: { taskId, kind: 'log', payload: { path: ['line'], equals: REVIEW_RECOVERY_LOG } },
  });
  if (recoveries >= MAX_REVIEW_RECOVERIES) return false;

  const recentLogs = await prisma.taskEvent.findMany({
    where: { taskId, kind: 'log' },
    orderBy: { createdAt: 'desc' },
    take: STUCK_REVIEW_LOG_SCAN,
    select: { payload: true },
  });
  // Newest first: the FIRST decisive line wins, so a conclusion logged after
  // an old error is not re-reviewed, and an error after a queued re-review
  // (that follow-up job died) still recovers.
  for (const entry of recentLogs) {
    const line = logLine(entry);
    if (!line) continue;
    if (line.startsWith('error:')) return true;
    if (CONCLUDED_REVIEW_MARKERS.some((marker) => line.startsWith(marker))) return false;
  }

  // Silent-death path: no decisive line — recover only when the task has
  // been quiet for a while AND no job for it lives in the queue. A missing
  // updatedAt (never happens for real rows) is treated as fresh: when
  // unsure, do not recover.
  const latest = await prisma.taskEvent.findFirst({
    where: { taskId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const lastActivity = Math.max(latest?.createdAt.getTime() ?? 0, taskUpdatedAt?.getTime() ?? Date.now());
  if (Date.now() - lastActivity < STUCK_REVIEW_STALE_MS) return false;
  return !(await hasLiveJobForTask(taskId));
}

// Re-enqueues review for awaiting_review/reviewing_code tasks whose review
// job died for good. The BullMQ jobId dedupes against a review job that is
// still waiting/active/retrying.
export async function recoverStuckReviews(): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: {
      status: { in: ['awaiting_review', 'reviewing_code'] },
      archivedAt: null,
      branchName: { not: null },
      repository: { autoReviewPr: true, connection: { disconnectedAt: null } },
    },
    select: { id: true, updatedAt: true },
  });
  let recovered = 0;
  for (const task of tasks) {
    if (!(await isReviewStuck(task.id, task.updatedAt))) continue;
    await logEvent(task.id, REVIEW_RECOVERY_LOG);
    await enqueueReviewTask(task.id);
    recovered += 1;
  }
  if (recovered > 0) {
    logger.info({ recovered }, 'pr-state-sync: re-enqueued stuck reviews');
  }
}
