import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { prisma } from './prisma.js';

// BullMQ queue shared by the API (enqueueing tasks) and the worker
// (repeatable 'generate-proposals' jobs). The queue name is pinned —
// the worker consumes the same name.

export const AGENT_QUEUE_NAME = 'agent-tasks';

const PROPOSAL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h

let queue: Queue | null = null;

export function getAgentTasksQueue(): Queue {
  if (!queue) {
    queue = new Queue(AGENT_QUEUE_NAME, {
      connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
    });
  }
  return queue;
}

const schedulerIdFor = (repositoryId: string): string => `proposals:${repositoryId}`;

// Registers (or refreshes) a repeatable 'generate-proposals' job for the repo.
export async function scheduleProposals(repositoryId: string): Promise<void> {
  await getAgentTasksQueue().upsertJobScheduler(
    schedulerIdFor(repositoryId),
    { every: PROPOSAL_INTERVAL_MS },
    { name: 'generate-proposals', data: { repositoryId } },
  );
}

export async function unscheduleProposals(repositoryId: string): Promise<void> {
  await getAgentTasksQueue().removeJobScheduler(schedulerIdFor(repositoryId));
}

// Re-adds repeatable jobs for every repo with autoPropose=true. Called at
// worker startup so schedules survive Redis flushes and redeploys.
export async function bootstrapProposalSchedules(): Promise<void> {
  const repositories = await prisma.repository.findMany({
    where: { autoPropose: true },
    select: { id: true },
  });
  for (const repository of repositories) {
    await scheduleProposals(repository.id);
  }
  console.log(`bootstrapped ${repositories.length} proposal schedule(s)`);
}

// Enqueues a 'run-task' job. jobId dedupes concurrent enqueues of the same task.
export async function enqueueRunTask(taskId: string): Promise<void> {
  await getAgentTasksQueue().add(
    'run-task',
    { taskId },
    { jobId: `run-task:${taskId}`, removeOnComplete: 100, removeOnFail: 100 },
  );
}

// Enqueues a one-shot 'generate-proposals' job (e.g. when autoPropose is
// toggled on). jobId dedupes concurrent enqueues for the same repo.
export async function enqueueGenerateProposalsNow(repositoryId: string): Promise<void> {
  await getAgentTasksQueue().add(
    'generate-proposals',
    { repositoryId },
    { jobId: `generate-proposals:${repositoryId}`, removeOnComplete: 100, removeOnFail: 100 },
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
