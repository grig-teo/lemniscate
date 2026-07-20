import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { MAX_PENDING_PROPOSALS } from './agent-proposals.js';
import { prisma } from './prisma.js';

// BullMQ queue shared by the API (enqueueing tasks) and the worker
// (repeatable 'proposals-topup' job). The queue name is pinned —
// the worker consumes the same name.

export const AGENT_QUEUE_NAME = 'agent-tasks';

const PROPOSAL_TOPUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
const TOPUP_SCHEDULER_ID = 'proposals-topup';

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
export async function enqueueProposalTopUps(): Promise<void> {
  const repositories = await prisma.repository.findMany({ select: { id: true } });
  const counts = await pendingProposalCounts();
  let enqueued = 0;
  for (const repository of repositories) {
    if ((counts.get(repository.id) ?? 0) >= MAX_PENDING_PROPOSALS) continue;
    await enqueueGenerateProposalsNow(repository.id);
    enqueued += 1;
  }
  console.log(
    `proposals-topup: enqueued generation for ${enqueued}/${repositories.length} repositories`,
  );
}

// Enqueues a 'run-task' job. jobId dedupes concurrent enqueues of the same task.
export async function enqueueRunTask(taskId: string): Promise<void> {
  await getAgentTasksQueue().add(
    'run-task',
    { taskId },
    { jobId: `run-task:${taskId}`, removeOnComplete: 100, removeOnFail: 100 },
  );
}

// Enqueues a one-shot 'generate-proposals' job (round button / top-up).
// jobId dedupes enqueues only while a job is waiting/active: finished jobs
// are removed immediately, otherwise BullMQ would keep them and silently
// swallow every later enqueue for the same repo.
export async function enqueueGenerateProposalsNow(repositoryId: string): Promise<void> {
  await getAgentTasksQueue().add(
    'generate-proposals',
    { repositoryId },
    { jobId: `generate-proposals:${repositoryId}`, removeOnComplete: true, removeOnFail: true },
  );
}

// Enqueues a 'review-pr' job (LLM review → fix iterations → optional merge).
// jobId includes the attempt so re-reviews after a fix are not deduped away.
export async function enqueueReviewTask(taskId: string, attempt = 0): Promise<void> {
  await getAgentTasksQueue().add(
    'review-pr',
    { taskId, attempt },
    { jobId: `review-pr:${taskId}:${attempt}`, removeOnComplete: 100, removeOnFail: 100 },
  );
}
