import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { cleanupWorkdir, logEvent } from './agent-git.js';
import { pullRequestState, type PrState } from './pull-requests.js';
import { getAgentTasksQueue } from './proposal-scheduler.js';
import { prisma } from './prisma.js';
import { setTaskStatus } from './task-events.js';
import { errorMessage } from './utils.js';

// Repeatable 'pr-state-sync' job. A task whose PR is merged manually on the
// git host (or merged while the worker was down) would sit in awaiting_review
// forever — this polls the provider and marks those tasks done.

const PR_STATE_SYNC_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const PR_STATE_SYNC_SCHEDULER_ID = 'pr-state-sync';

type TaskWithConnection = Prisma.TaskGetPayload<{
  include: { repository: { include: { connection: true } } };
}>;

// Registers the single global repeatable 'pr-state-sync' job. Called at
// worker startup so the schedule survives Redis flushes and redeploys.
export async function registerPrStateSyncSchedule(): Promise<void> {
  await getAgentTasksQueue().upsertJobScheduler(
    PR_STATE_SYNC_SCHEDULER_ID,
    { every: PR_STATE_SYNC_INTERVAL_MS },
    { name: 'pr-state-sync', data: {} },
  );
}

/** Task status for a polled PR state; null leaves the task unchanged. */
export function taskStatusForPrState(state: PrState): 'done' | null {
  return state === 'merged' ? 'done' : null;
}

// Polls one task's PR; returns true when the task was marked done. Provider
// failures are logged and skipped — the next run retries.
async function syncTaskPrState(task: TaskWithConnection): Promise<boolean> {
  if (!task.branchName) return false;
  try {
    const state = await pullRequestState(task.repository.connection, {
      repoFullName: task.repository.fullName,
      headBranch: task.branchName,
      baseBranch: task.repository.defaultBranch,
    });
    if (taskStatusForPrState(state) !== 'done') return false;
    await setTaskStatus(task.id, 'done');
    await logEvent(task.id, 'pull request merged on the git host — task marked done');
    // The run workdir was kept for the review window — merged means cleanup.
    await cleanupWorkdir(path.join(config.AGENT_WORKDIR, task.id), task.id);
    return true;
  } catch (err) {
    console.warn(`pr-state-sync: check failed for task ${task.id}: ${errorMessage(err)}`);
    return false;
  }
}

// Job: pr-state-sync — marks awaiting_review tasks done when their PR was
// merged on the git host. Closed-without-merge PRs are left untouched.
export async function syncMergedPullRequests(): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: {
      status: 'awaiting_review',
      prUrl: { not: null },
      branchName: { not: null },
      archivedAt: null,
      repository: { connection: { disconnectedAt: null } },
    },
    include: { repository: { include: { connection: true } } },
  });
  let marked = 0;
  for (const task of tasks) {
    if (await syncTaskPrState(task)) marked += 1;
  }
  if (tasks.length > 0) {
    console.log(`pr-state-sync: marked ${marked}/${tasks.length} awaiting-review task(s) done`);
  }
}
