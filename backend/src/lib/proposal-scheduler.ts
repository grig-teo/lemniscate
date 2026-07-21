import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { MAX_PENDING_PROPOSALS } from './agent-proposals.js';
import { prisma } from './prisma.js';

// BullMQ queue shared by the API (enqueueing tasks) and the worker
// (repeatable 'proposals-topup' job). The queue name is pinned —
// the worker consumes the same name.

export const AGENT_QUEUE_NAME = 'agent-tasks';

const PROPOSAL_TOPUP_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
const TOPUP_SCHEDULER_ID = 'proposals-topup';
const AUTORUN_INTERVAL_MS = 20 * 60 * 1000; // every 20 minutes
const AUTORUN_SCHEDULER_ID = 'proposals-autorun';

let queue: Queue | null = null;

export function getAgentTasksQueue(): Queue {
  if (!queue) {
    queue = new Queue(AGENT_QUEUE_NAME, {
      connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
    });
  }
  return queue;
}

// Registers the single global repeatable 'proposals-topup' job. Called at
// worker startup so the schedule survives Redis flushes and redeploys.
export async function registerProposalTopUpSchedule(): Promise<void> {
  await getAgentTasksQueue().upsertJobScheduler(
    TOPUP_SCHEDULER_ID,
    { every: PROPOSAL_TOPUP_INTERVAL_MS },
    { name: 'proposals-topup', data: {} },
  );
}

// Registers the repeatable 'proposals-autorun' job (every 20 min), which
// starts pending proposals for repos that opted in via autoRunProposals.
export async function registerProposalAutoRunSchedule(): Promise<void> {
  await getAgentTasksQueue().upsertJobScheduler(
    AUTORUN_SCHEDULER_ID,
    { every: AUTORUN_INTERVAL_MS },
    { name: 'proposals-autorun', data: {} },
  );
}

// Job: proposals-autorun — for every repo with autoRunProposals on, start the
// oldest pending proposal, but only when no proposal of that repo is already
// queued/running (one at a time per repo).
export async function enqueueProposalAutoRuns(): Promise<void> {
  const repositories = await prisma.repository.findMany({
    where: { autoRunProposals: true },
    select: { id: true },
  });
  let started = 0;
  for (const repository of repositories) {
    if (await startNextProposal(repository.id)) started += 1;
  }
  console.log(`proposals-autorun: started ${started}/${repositories.length} proposal(s)`);
}

// Returns true when a pending proposal was queued for the repository.
async function startNextProposal(repositoryId: string): Promise<boolean> {
  const active = await prisma.task.count({
    where: { repositoryId, kind: 'proposal', status: { in: ['queued', 'running'] } },
  });
  if (active > 0) return false;
  const next = await prisma.task.findFirst({
    where: { repositoryId, kind: 'proposal', status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!next) return false;
  await prisma.task.update({ where: { id: next.id }, data: { status: 'queued' } });
  await enqueueRunTask(next.id);
  return true;
}

// Pending proposal count per repository (repos with none are absent).
async function pendingProposalCounts(): Promise<Map<string, number>> {
  const grouped = await prisma.task.groupBy({
    by: ['repositoryId'],
    where: { kind: 'proposal', status: 'pending' },
    _count: { repositoryId: true },
  });
  return new Map(grouped.map((row) => [row.repositoryId, row._count.repositoryId]));
}

// Job: proposals-topup — enqueues 'generate-proposals' for every repository
// below MAX_PENDING_PROPOSALS pending proposals, keeping each repo topped up.
// Bare repositories (README-only, no implementation) are skipped — there is
// no codebase to analyze.
export async function enqueueProposalTopUps(): Promise<void> {
  const repositories = await prisma.repository.findMany({ select: { id: true, bare: true } });
  const counts = await pendingProposalCounts();
  let enqueued = 0;
  for (const repository of repositories) {
    if (repository.bare) continue;
    if ((counts.get(repository.id) ?? 0) >= MAX_PENDING_PROPOSALS) continue;
    await enqueueGenerateProposalsNow(repository.id);
    enqueued += 1;
  }
  console.log(
    `proposals-topup: enqueued generation for ${enqueued}/${repositories.length} repositories`,
  );
}

// Enqueues a 'run-task' job. jobId dedupes concurrent enqueues of the same task.
// BullMQ rejects custom jobIds containing ':' unless they have exactly 3
// segments (legacy repeat-job format), so all our jobIds use dashes.
// Finished jobs are removed immediately — kept records would silently
// swallow every rerun of an already-run task (dedupe by jobId).
export async function enqueueRunTask(taskId: string): Promise<void> {
  await getAgentTasksQueue().add(
    'run-task',
    { taskId },
    { jobId: `run-task-${taskId}`, removeOnComplete: true, removeOnFail: true },
  );
}

// Worker-startup recovery: re-enqueue tasks stuck in 'queued' without a job
// (e.g. an enqueue that failed after the status was already updated).
// jobId dedupe makes this safe for tasks that do have a waiting job.
export async function recoverQueuedTasks(): Promise<void> {
  const stuck = await prisma.task.findMany({ where: { status: 'queued' }, select: { id: true } });
  for (const task of stuck) {
    await enqueueRunTask(task.id);
  }
  if (stuck.length > 0) {
    console.log(`recovery: re-enqueued ${stuck.length} queued task(s)`);
  }
}

// Enqueues a one-shot 'generate-proposals' job (round button / top-up).
// jobId dedupes enqueues only while a job is waiting/active: finished jobs
// are removed immediately, otherwise BullMQ would keep them and silently
// swallow every later enqueue for the same repo.
export async function enqueueGenerateProposalsNow(repositoryId: string): Promise<void> {
  await getAgentTasksQueue().add(
    'generate-proposals',
    { repositoryId },
    { jobId: `generate-proposals-${repositoryId}`, removeOnComplete: true, removeOnFail: true },
  );
}

// Enqueues a 'review-pr' job (LLM review → fix iterations → optional merge).
// jobId includes the attempt so re-reviews after a fix are not deduped away.
// Finished jobs are removed immediately (same rerun-swallow rule as run-task).
export async function enqueueReviewTask(taskId: string, attempt = 0): Promise<void> {
  await getAgentTasksQueue().add(
    'review-pr',
    { taskId, attempt },
    { jobId: `review-pr-${taskId}-${attempt}`, removeOnComplete: true, removeOnFail: true },
  );
}
