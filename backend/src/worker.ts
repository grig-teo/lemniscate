import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config, MONITORED_SECRETS } from './config.js';
import { planWorkdirSweep } from './lib/agent-git.js';
import { generateProposals, stampProposalFailure, stampProposalSuccess, reviewTask, runTask } from './lib/agent-loop.js';
import { mergeGateTask } from './lib/merge-gate.js';
import { deployService } from './lib/deploy/deploy-service.js';
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
import { registerPrStateSyncSchedule, recoverStuckReviews, syncMergedPullRequests } from './lib/pr-state-sync.js';
import { deliverNotification } from './lib/notification-delivery.js';
import { notifyProposalGenerationFailure } from './lib/notifications.js';
import { startHeartbeat } from './lib/worker-heartbeat.js';
import { jobFailureFromError, logJobFailure } from './lib/job-failure-log.js';
import { metrics, startQueueMetricsPoller } from './lib/metrics.js';
import { getRedisClient } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { initErrorReporting, reportError } from './lib/sentry.js';
import { redisEndpointForLog } from './lib/utils.js';
import { queueSnapshot, startWorkerHealthServer } from './lib/worker-health.js';

const runTaskDataSchema = z.object({ taskId: z.string().min(1) });
const reviewPrDataSchema = z.object({
  taskId: z.string().min(1),
  attempt: z.number().int().min(0).default(0),
});
const mergeGateDataSchema = z.object({
  taskId: z.string().min(1),
  attempt: z.number().int().min(0).default(0),
  ciFixes: z.number().int().min(0).default(0),
});
const deployServiceDataSchema = z.object({ deploymentId: z.string().min(1) });
const generateProposalsDataSchema = z.object({ repositoryId: z.string().min(1) });
const proposalsTopUpDataSchema = z.object({}).strict();
const notificationDeliveryDataSchema = z.object({ deliveryId: z.string().min(1) });

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
      status: { in: ['queued', 'running', 'awaiting_review', 'reviewing_code'] },
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
  if (orphans.length > 0) logger.info({ count: orphans.length }, 'swept orphaned workdirs');
}

await sweepOrphanedWorkdirs();

// Opt-in Sentry; a no-op unless SENTRY_DSN is set.
await initErrorReporting(config.SENTRY_DSN, MONITORED_SECRETS);

// Job names the worker dispatches on (kept in sync with the switch in
// processJob). Used to bound the job_name metric label: anything else —
// e.g. foreign jobs in the queue — folds into 'unknown' instead of growing
// cardinality.
const KNOWN_JOB_NAMES = new Set([
  'run-task',
  'review-pr',
  'merge-gate',
  'deploy-service',
  'generate-proposals',
  'proposals-topup',
  'proposals-autorun',
  'pr-state-sync',
  'notification-delivery',
]);

function jobMetricName(name: string): string {
  return KNOWN_JOB_NAMES.has(name) ? name : 'unknown';
}

// Wraps generateProposals with pipeline-health side effects: stamps
// lastProposalAt on success and lastProposalError on every failure, and
// emits a proposal_generation_failed notification only on the final retry
// attempt (so transient blips that recover do not alarm the user).
// The generic job_failed path in notifyJobFailure is skipped for this job
// name (see notifications.ts) to avoid a duplicate notification.
function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runGenerateProposals(repositoryId: string, job: Job): Promise<void> {
  try {
    await generateProposals(repositoryId);
    await stampProposalSuccess(repositoryId);
  } catch (err) {
    const message = errorMessage(err);
    await stampProposalFailure(repositoryId, message);
    if (isFinalAttempt(job)) {
      await notifyProposalGenerationFailure(repositoryId, message);
    }
    throw err;
  }
}

// One switch on job.name (AGENTS.md §4); metrics live in the decorator
// below so no case carries its own timing/try-catch.
async function processJob(job: Job): Promise<void> {
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
    case 'merge-gate': {
      const { taskId, attempt, ciFixes } = mergeGateDataSchema.parse(job.data);
      await mergeGateTask(taskId, attempt, ciFixes);
      return;
    }
    case 'deploy-service': {
      const { deploymentId } = deployServiceDataSchema.parse(job.data);
      await deployService(deploymentId);
      return;
    }
    case 'generate-proposals': {
      const { repositoryId } = generateProposalsDataSchema.parse(job.data);
      await runGenerateProposals(repositoryId, job);
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
    case 'notification-delivery': {
      const { deliveryId } = notificationDeliveryDataSchema.parse(job.data);
      await deliverNotification(deliveryId, job.attemptsMade);
      return;
    }
    default:
      throw new Error(`unknown job name: ${job.name}`);
  }
}

// observeJob wraps dispatch with the duration histogram + failure counter;
// failures rethrow so BullMQ retry semantics are untouched. The label is
// bounded via jobMetricName so foreign job names cannot grow cardinality.
const worker = new Worker(
  AGENT_QUEUE_NAME,
  async (job: Job) => metrics.observeJob(jobMetricName(job.name), () => processJob(job)),
  { connection, concurrency: config.AGENT_WORKER_CONCURRENCY },
);

function jobTaskId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { taskId } = data as { taskId?: unknown };
  return typeof taskId === 'string' ? taskId : undefined;
}

function jobRepositoryId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { repositoryId } = data as { repositoryId?: unknown };
  return typeof repositoryId === 'string' ? repositoryId : undefined;
}

worker.on('failed', (job, err) => {
  const entry = jobFailureFromError(job?.name ?? 'unknown', err, {
    jobId: job?.id,
    taskId: jobTaskId(job?.data),
    repositoryId: jobRepositoryId(job?.data),
  });
  // observeJob already counted this throw; log (and report) without
  // incrementing lemniscate_job_failures_total a second time.
  logJobFailure(entry, { recordMetric: false });
  reportError(err, { jobName: entry.jobName, jobId: entry.jobId, taskId: entry.taskId });
});

await worker.waitUntilReady();
// Never log config.REDIS_URL itself: it can embed a password
// (redis://:secret@host) which would end up in container logs.
logger.info(
  { queue: AGENT_QUEUE_NAME, redis: redisEndpointForLog(config.REDIS_URL) },
  'worker ready, consuming queue',
);

// Process-level tripwire: rewritten on a timer, so a wedged worker (blocked
// event loop, dead consumer) leaves a stale file an external watchdog can
// detect. The compose healthcheck probes the HTTP health server below; this
// file is only a fallback signal. An idle worker with an empty queue keeps
// ticking.
const stopHeartbeat = startHeartbeat();

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

// Re-enqueue reviews whose jobs died permanently while the worker was down
// (or before job retries existed) — otherwise they never reach auto-merge.
await recoverStuckReviews();

// Liveness + readiness endpoints: compose's healthcheck probes these; the
// queue counts /health serves (waiting/active/failed) make a stalled
// pipeline visible, and /health/ready 503s when Redis is unreachable or the
// consumer stopped. The same server exposes /metrics (Prometheus: job
// durations/failures, LLM outcomes, queue gauges) — the worker has no other
// HTTP surface, so it shares this internal port.
const healthServer = startWorkerHealthServer(getAgentTasksQueue(), config.WORKER_HEALTH_PORT, {
  checkRedis: () => getRedisClient().ping(),
  isRunning: () => worker.isRunning(),
  renderMetrics: () => metrics.render(),
});
logger.info({ port: config.WORKER_HEALTH_PORT }, 'worker health endpoint listening');

// Refresh lemniscate_queue_jobs gauges every 15s. Same source as /health
// (queueSnapshot folds the 'wait' alias into 'waiting'), polled on an
// interval so scrapes never hammer Redis.
const QUEUE_METRICS_INTERVAL_MS = 15_000;
const stopQueueMetrics = startQueueMetricsPoller(
  metrics,
  [
    {
      name: AGENT_QUEUE_NAME,
      getCounts: async () => (await queueSnapshot(getAgentTasksQueue())).counts,
    },
  ],
  QUEUE_METRICS_INTERVAL_MS,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopQueueMetrics();
    stopHeartbeat();
    healthServer.close();
    void worker.close().then(
      () => connection.quit(),
      () => connection.disconnect(),
    );
  });
}
