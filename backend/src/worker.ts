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
  getAgentTasksQueue,
  recoverInterruptedTasks,
  recoverQueuedTasks,
  registerProposalAutoRunSchedule,
  registerProposalTopUpSchedule,
} from './lib/proposal-scheduler.js';
import { registerPrStateSyncSchedule, syncMergedPullRequests } from './lib/pr-state-sync.js';
import { jobFailureFromError, logJobFailure } from './lib/job-failure-log.js';
import { startWorkerHealthServer } from './lib/worker-health.js';

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

// Boot-time sweep: remove AGENT_WORKDIR subdirectories no active task owns —
// stale clones (with .git dirs) left behind by a SIGKILLed worker. Workdirs
// of awaiting_review tasks are kept: they are removed on merge, not at run
// end. Runs before the Worker starts consuming so nothing races it.
async function sweepOrphanedWorkdirs(): Promise<void> {
  const active = await prisma.task.findMany({
    where: {
      status: { in: ['queued', 'running', 'awaiting_review'] },
      archivedAt: null,
    },
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
      case 'pr-state-sync': {
        proposalsTopUpDataSchema.parse(job.data);
        await syncMergedPullRequests();
        return;
      }
      default:
        throw new Error(`unknown job name: ${job.name}`);
    }
  },
  { connection, concurrency: config.AGENT_WORKER_CONCURRENCY },
);

function jobTaskId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { taskId } = data as { taskId?: unknown };
  return typeof taskId === 'string' ? taskId : undefined;
}

worker.on('failed', (job, err) => {
  logJobFailure(
    jobFailureFromError(job?.name ?? 'unknown', err, {
      jobId: job?.id,
      taskId: jobTaskId(job?.data),
    }),
  );
});

await worker.waitUntilReady();
console.log(`worker ready, consuming queue '${AGENT_QUEUE_NAME}' via ${config.REDIS_URL}`);

// Register the single global repeatable 'proposals-topup' job (every 6h).
await registerProposalTopUpSchedule();
await registerProposalAutoRunSchedule();
await registerPrStateSyncSchedule();

// Re-enqueue any tasks left in 'queued' without a job (crashed/failed
// enqueues from before the worker came up).
await recoverQueuedTasks();

// Re-queue tasks left in 'running' by a killed worker (redeploy mid-run);
// their persisted workdirs let the re-runs resume where they stopped.
await recoverInterruptedTasks();

// Liveness endpoint: compose's healthcheck probes this; the queue counts it
// serves (waiting/active/failed) make a stalled pipeline visible.
const healthServer = startWorkerHealthServer(getAgentTasksQueue(), config.WORKER_HEALTH_PORT);
console.log(`worker health endpoint listening on :${config.WORKER_HEALTH_PORT}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    healthServer.close();
    void worker.close().then(
      () => connection.quit(),
      () => connection.disconnect(),
    );
  });
}
