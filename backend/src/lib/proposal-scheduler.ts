import type { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { MAX_PENDING_PROPOSALS } from './agent-proposals.js';
import { prisma } from './prisma.js';
import { getAgentTasksQueue } from './queue.js';

// Repeatable schedulers + enqueue helpers on the shared agent queue (the
// queue itself lives in lib/queue.ts — single home, re-exported here so
// existing importers keep working).

export { AGENT_QUEUE_NAME, getAgentTasksQueue } from './queue.js';

const PROPOSAL_TOPUP_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
const TOPUP_SCHEDULER_ID = 'proposals-topup';
const AUTORUN_INTERVAL_MS = 20 * 60 * 1000; // every 20 minutes
const AUTORUN_SCHEDULER_ID = 'proposals-autorun';

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
    where: { autoRunProposals: true, connection: { disconnectedAt: null } },
    select: { id: true },
  });
  let started = 0;
  for (const repository of repositories) {
    if (await startNextProposal(repository.id)) started += 1;
  }
  console.log(`proposals-autorun: started ${started}/${repositories.length} proposal(s)`);
}

// Returns true when a pending proposal was queued for the repository.
// The claim is atomic: a per-repository advisory lock serializes overlapping
// autorun ticks (and ticks racing a manual start), and the pending-only
// updateMany loses the race against a concurrent cancel instead of
// resurrecting the task — the "one active proposal per repo" invariant holds.
export async function startNextProposal(repositoryId: string): Promise<boolean> {
  const claimedId = await claimNextProposal(repositoryId);
  if (!claimedId) return false;
  await enqueueRunTask(claimedId);
  return true;
}

// Claims the oldest pending proposal inside one transaction guarded by
// pg_advisory_xact_lock, so concurrent ticks cannot both pass the "no active
// proposal" check. Returns the claimed task id, or null when there is
// nothing (safe) to start. The lock is released at transaction end.
// Exported for the real-Postgres race test
// (tests/proposal-claim.integration.test.ts, INTEGRATION=1).
export async function claimNextProposal(repositoryId: string): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${repositoryId}))`;
    if (await hasActiveProposal(tx, repositoryId)) return null;
    return claimOldestPending(tx, repositoryId);
  });
}

async function hasActiveProposal(
  tx: Prisma.TransactionClient,
  repositoryId: string,
): Promise<boolean> {
  const active = await tx.task.count({
    where: { repositoryId, kind: 'proposal', status: { in: ['queued', 'running'] } },
  });
  return active > 0;
}

// Flips the oldest pending proposal to queued only when it is still pending:
// a task cancelled between the select and the claim stays cancelled
// (updateMany matches 0 rows and the claim is abandoned).
async function claimOldestPending(
  tx: Prisma.TransactionClient,
  repositoryId: string,
): Promise<string | null> {
  const next = await tx.task.findFirst({
    where: { repositoryId, kind: 'proposal', status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!next) return null;
  const claimed = await tx.task.updateMany({
    where: { id: next.id, status: 'pending' },
    data: { status: 'queued' },
  });
  return claimed.count === 1 ? next.id : null;
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
  const repositories = await prisma.repository.findMany({
    where: { connection: { disconnectedAt: null } },
    select: { id: true, bare: true },
  });
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

// BullMQ priority: 0 = highest. User-driven work must not queue behind
// background proposal generation — the recurring top-up saturates all worker
// slots (concurrency 4 × every repo every 10 min), so without priorities a
// user's task waits minutes for a slot even though it matters more.
export const JOB_PRIORITY = { userTask: 1, review: 2, background: 10 } as const;

// Enqueues a 'run-task' job. jobId dedupes concurrent enqueues of the same task.
// BullMQ rejects custom jobIds containing ':' unless they have exactly 3
// segments (legacy repeat-job format), so all our jobIds use dashes.
// Finished jobs are removed immediately — kept records would silently
// swallow every rerun of an already-run task (dedupe by jobId).
export async function enqueueRunTask(taskId: string): Promise<void> {
  await getAgentTasksQueue().add(
    'run-task',
    { taskId },
    {
      jobId: `run-task-${taskId}`,
      removeOnComplete: true,
      removeOnFail: true,
      priority: JOB_PRIORITY.userTask,
    },
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

// Worker-startup recovery: tasks left in 'running' by a killed worker
// (redeploy mid-run) are re-queued. Their clones survive on the persistent
// workdir volume, so the re-run resumes from the saved state instead of
// starting over. jobId dedupe covers jobs still tracked as stalled.
export async function recoverInterruptedTasks(): Promise<void> {
  const stuck = await prisma.task.findMany({ where: { status: 'running' }, select: { id: true } });
  for (const task of stuck) {
    await prisma.task.update({ where: { id: task.id }, data: { status: 'queued' } });
    await enqueueRunTask(task.id);
  }
  if (stuck.length > 0) {
    console.log(`recovery: re-queued ${stuck.length} interrupted running task(s)`);
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
    {
      jobId: `generate-proposals-${repositoryId}`,
      removeOnComplete: true,
      removeOnFail: true,
      priority: JOB_PRIORITY.background,
    },
  );
}

// Enqueues a 'deploy-service' job (docker build → start → health → flip).
// Low priority: builds are CPU-heavy and must not starve agent tasks.
export async function enqueueDeployService(deploymentId: string): Promise<void> {
  await getAgentTasksQueue().add(
    'deploy-service',
    { deploymentId },
    {
      jobId: `deploy-${deploymentId}`,
      removeOnComplete: true,
      removeOnFail: true,
      priority: JOB_PRIORITY.background,
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
}

// Enqueues a 'merge-gate' job: the CI-gated auto-merge owner for a reviewed
// PR. Re-enqueues itself (delayed) while checks are pending, after a CI fix
// push, and after a conflict-resolution push; `attempt`/`ciFixes` bound the
// loop and make every jobId unique, so a scheduled re-check is never
// deduped away by the previous one.
export async function enqueueMergeGate(
  taskId: string,
  attempt = 0,
  ciFixes = 0,
  delayMs = 0,
): Promise<void> {
  await getAgentTasksQueue().add(
    'merge-gate',
    { taskId, attempt, ciFixes },
    {
      jobId: `merge-gate-${taskId}-${attempt}-${ciFixes}`,
      removeOnComplete: true,
      removeOnFail: true,
      priority: JOB_PRIORITY.review,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      ...(delayMs > 0 ? { delay: delayMs } : {}),
    },
  );
}

// Enqueues a 'review-pr' job (LLM review → fix iterations → merge gate).
// jobId includes the attempt so re-reviews after a fix are not deduped away.
// Finished jobs are removed immediately (same rerun-swallow rule as run-task).
// BullMQ retries a failed job with backoff — transient LLM/git failures used
// to strand the task in awaiting_review forever with the PR never merging.
export async function enqueueReviewTask(taskId: string, attempt = 0): Promise<void> {
  await getAgentTasksQueue().add(
    'review-pr',
    { taskId, attempt },
    {
      jobId: `review-pr-${taskId}-${attempt}`,
      removeOnComplete: true,
      removeOnFail: true,
      priority: JOB_PRIORITY.review,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
    },
  );
}
