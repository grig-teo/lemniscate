import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { planWorkdirSweep } from './lib/agent-git.js';
import { generateProposals, reviewTask, runTask } from './lib/agent-loop.js';
import { prisma } from './lib/prisma.js';
import {
  AGENT_QUEUE_NAME,
  enqueueProposalAutoRuns,
  enqueueProposalTopUps,
  recoverQueuedTasks,
  registerProposalAutoRunSchedule,
  registerProposalTopUpSchedule,
} from './lib/proposal-scheduler.js';

const runTaskDataSchema = z.object({ taskId: z.string().min(1) });
const reviewPrDataSchema = z.object({
  taskId: z.string().min(1),
  attempt: z.number().int().min(0).default(0),
});
const generateProposalsDataSchema = z.object({ repositoryId: z.string().min(1) });
const proposalsTopUpDataSchema = z.object({}).strict();

// BullMQ requires maxRetriesPerRequest: null on blocking connections.
const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Boot-time sweep: remove AGENT_WORKDIR subdirectories no queued/running
// task owns — stale clones (with .git dirs) left behind by a SIGKILLed
// worker. Runs before the Worker starts consuming so nothing races it.
async function sweepOrphanedWorkdirs(): Promise<void> {
  const active = await prisma.task.findMany({
    where: { status: { in: ['queued', 'running'] } },
    select: { id: true },
  });
  const activeIds = new Set(active.map((task) => task.id));
  const entries = await fs
    .readdir(config.AGENT_WORKDIR, { withFileTypes: true })
    .catch(() => []);
  const dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const orphans = planWorkdirSweep(dirNames, activeIds);
  for (const name of orphans) {
    await fs.rm(path.join(config.AGENT_WORKDIR, name), { recursive: true, force: true }).catch(() => {});
  }
  if (orphans.length > 0) console.log(`swept ${orphans.length} orphaned workdir(s)`);
}

await sweepOrphanedWorkdirs();

const worker = new Worker(
  AGENT_QUEUE_NAME,
  async (job: Job) => {
    switch (job.name) {
      case 'run-task': {
        const { taskId } = runTaskDataSchema.parse(job.data);
        await runTask(taskId);
        return;
      }
      case 'review-pr': {
        const { taskId, attempt } = reviewPrDataSchema.parse(job.data);
        await reviewTask(taskId, attempt);
        return;
      }
      case 'generate-proposals': {
        const { repositoryId } = generateProposalsDataSchema.parse(job.data);
        await generateProposals(repositoryId);
        return;
      }
      case 'proposals-topup': {
        proposalsTopUpDataSchema.parse(job.data);
        await enqueueProposalTopUps();
        return;
      }
      case 'proposals-autorun': {
        proposalsTopUpDataSchema.parse(job.data);
        await enqueueProposalAutoRuns();
        return;
      }
      default:
        throw new Error(`unknown job name: ${job.name}`);
    }
  },
  { connection, concurrency: config.AGENT_WORKER_CONCURRENCY },
);

worker.on('failed', (job, err) => {
  console.error(`job ${job?.id} (${job?.name}) failed:`, err);
});

await worker.waitUntilReady();
console.log(`worker ready, consuming queue '${AGENT_QUEUE_NAME}' via ${config.REDIS_URL}`);

// Register the single global repeatable 'proposals-topup' job (every 6h).
await registerProposalTopUpSchedule();
await registerProposalAutoRunSchedule();

// Re-enqueue any tasks left in 'queued' without a job (crashed/failed
// enqueues from before the worker came up).
await recoverQueuedTasks();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void worker.close().then(
      () => connection.quit(),
      () => connection.disconnect(),
    );
  });
}
