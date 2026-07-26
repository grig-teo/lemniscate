import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { cleanupWorkdir, logEvent } from './agent-git.js';
import { notify } from './notifications.js';
import { type PrState } from './pull-requests.js';
import { setTaskStatus } from './task-events.js';
import { errorMessage } from './utils.js';

// Shared PR-state application: the ONE function both the pr-state-sync poller
// and the inbound webhook receiver call to flip a task from awaiting_review to
// done/closed, log, notify, and clean up the run workdir (AGENTS.md §6 — single
// home for this rule). Extracted from pr-state-sync.ts so the webhook path does
// not duplicate the notify/logEvent/cleanupWorkdir sequence.

export type TaskWithConnection = Prisma.TaskGetPayload<{
  include: { repository: { include: { connection: true } } };
}>;

/** Task status for a PR state; null leaves the task unchanged. */
export function taskStatusForPrState(state: PrState): 'done' | 'closed' | null {
  if (state === 'merged') return 'done';
  if (state === 'closed') return 'closed';
  return null;
}

// Applies a PR state to the task: flips the status, logs, notifies the repo
// owner, and drops the kept run workdir (the PR is finished either way).
// Returns true when the task left awaiting_review.
export async function applyTaskPrState(
  task: TaskWithConnection,
  state: PrState,
): Promise<boolean> {
  const status = taskStatusForPrState(state);
  if (status === null) return false;
  await setTaskStatus(task.id, status);
  const what = status === 'done' ? 'merged' : 'closed without merge';
  await logEvent(task.id, `pull request ${what} on the git host — task marked ${status}`);
  await notify(task.repository.connection.userId, status === 'done' ? 'pr_merged' : 'pr_closed', {
    title: `PR ${status === 'done' ? 'merged' : 'closed'}: ${task.title}`,
    body: `${task.repository.fullName} — pull request ${what} on the git host`,
    taskId: task.id,
    prUrl: task.prUrl ?? undefined,
  });
  await cleanupWorkdir(path.join(config.AGENT_WORKDIR, task.id), task.id);
  return true;
}

// DB/event failures are logged and skipped — the next poll or webhook retries.
export async function applyTaskPrStateSafe(
  task: TaskWithConnection,
  state: PrState,
  source: string = 'pr-state-sync',
): Promise<boolean> {
  try {
    return await applyTaskPrState(task, state);
  } catch (err) {
    console.warn(`${source}: update failed for task ${task.id}: ${errorMessage(err)}`);
    return false;
  }
}
