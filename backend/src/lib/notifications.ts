import { prisma } from './prisma.js';
import { MONITORED_SECRETS } from '../config.js';
import { dispatchToChannels } from './notification-delivery.js';
import { failureSecrets } from './notification-secrets.js';
import { friendlyErrorMessage } from './friendly-error.js';
import { logger } from './logger.js';
import { redactSecrets } from './utils.js';

// Single home for user-facing notifications of async agent events
// (AGENTS.md §6): every producer (PR opened in agent-run.ts, PR merged/
// closed in pr-state-sync.ts, task completion in agent-run.ts runTask,
// merge-gate outcomes in merge-gate.ts, job failures via logJobFailure in
// job-failure-log.ts) funnels through the emitters here. One Notification
// row is the source of truth for the in-app bell; dispatchToChannels()
// fans the same event out to the user's outbound channels (signed webhook /
// email — see lib/notification-delivery.ts) as a best-effort side effect
// that never blocks or fails the caller.

export const NOTIFICATION_KINDS = [
  'pr_opened',
  'pr_merged',
  'pr_closed',
  'run_failed',
  'budget_exceeded',
  'llm_failover',
  'task_completed',
  'merge_gate_failed',
  'job_failed',
  'proposal_generation_failed',
  'review_addressed',
  // Internal gitlem host: account auto-provisioned for a user.
  'gitlem_account_created',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationPayload {
  title: string;
  body: string;
  taskId?: string;
  prUrl?: string;
}

// Signing helpers live with the transport (notification-delivery.ts) and are
// re-exported so existing importers (routes, tests) keep one import path.
export {
  generateWebhookSecret,
  signWebhookBody,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMEOUT_MS,
} from './notification-delivery.js';

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

// Writes the Notification row, then fans out to the user's outbound
// channels. Never throws into the caller: a notification must not fail the
// job that produced it.
export async function notify(
  userId: string,
  kind: NotificationKind,
  payload: NotificationPayload,
): Promise<void> {
  try {
    const notification = await prisma.notification.create({
      data: {
        userId,
        kind,
        title: payload.title.slice(0, 200),
        body: payload.body.slice(0, 2_000),
        taskId: payload.taskId ?? null,
        prUrl: payload.prUrl ?? null,
      },
    });
    await dispatchToChannels(
      userId,
      kind,
      { title: notification.title, body: notification.body, taskId: payload.taskId, prUrl: payload.prUrl },
      notification.id,
    );
  } catch (err) {
    logger.error({ kind, userId, err }, 'failed to record notification');
  }
}

// Deduped variant for outcomes that can fire repeatedly while a task stays
// in a non-terminal state (merge gate giving up is re-evaluated on every
// recovery re-enqueue): one unread row per task+kind at a time.
export async function notifyOncePerTask(
  userId: string,
  kind: NotificationKind,
  payload: NotificationPayload & { taskId: string },
): Promise<void> {
  const existing = await prisma.notification.findFirst({
    where: { taskId: payload.taskId, kind, readAt: null },
    select: { id: true },
  });
  if (existing) return;
  await notify(userId, kind, payload);
}

// Task-scoped failure entry point used via logJobFailure (the single failure
// funnel: job-failure-log.ts — also what recordJobFailure in agent-git.ts
// emits through): resolves the owning user from the task, maps
// TokenBudgetExceededError to its own kind, and dedupes against an unread
// notification for the same task+kind so BullMQ retries of a review/merge
// job cannot spam the user. The message is re-scrubbed here even though
// recordJobFailure sanitizes its own: worker-level failures reach this path
// with a raw err.message.
export async function notifyTaskFailure(
  taskId: string,
  errorKind: string,
  message: string,
): Promise<void> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      title: true,
      repository: {
        select: {
          fullName: true,
          connection: { select: { userId: true, accessTokenEnc: true, refreshTokenEnc: true } },
        },
      },
    },
  });
  if (!task) return;
  const kind: NotificationKind =
    errorKind === 'TokenBudgetExceededError' ? 'budget_exceeded' : 'run_failed';
  const title = kind === 'budget_exceeded' ? 'Token budget exceeded' : 'Run failed';
  const secrets = await failureSecrets(task.repository.connection);
  await notifyOncePerTask(task.repository.connection.userId, kind, {
    title: `${title}: ${task.title}`,
    body: `${task.repository.fullName} — ${friendlyErrorMessage(redactSecrets(message, secrets))}`,
    taskId,
  });
}

// runTask completion entry point (agent-run.ts): notifies only when the run
// actually reached 'done' — the awaiting_review outcome has its own
// pr_opened event, so auto-PR tasks are not double-notified.
export async function notifyTaskCompleted(taskId: string): Promise<void> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      status: true,
      title: true,
      repository: { select: { fullName: true, connection: { select: { userId: true } } } },
    },
  });
  if (!task || task.status !== 'done') return;
  await notify(task.repository.connection.userId, 'task_completed', {
    title: `Task completed: ${task.title}`,
    body: `${task.repository.fullName} — run finished`,
    taskId,
  });
}

export interface JobFailureNotification {
  jobName: string;
  errorKind: string;
  message: string;
  taskId?: string;
  repositoryId?: string;
}

// logJobFailure hook (job-failure-log.ts — the single failure funnel):
// task-scoped failures reuse the run_failed path; repository-scoped failures
// (the scheduled 'generate-proposals' runs) have their own dedicated
// proposal_generation_failed path (see notifyProposalGenerationFailure),
// so this generic job_failed branch is skipped for that job name.
// Messages are scrubbed against the owner's tokens/keys — worker-level
// failures arrive unsanitized.
export async function notifyJobFailure(entry: JobFailureNotification): Promise<void> {
  try {
    if (entry.taskId) {
      await notifyTaskFailure(entry.taskId, entry.errorKind, entry.message);
      return;
    }
    // generate-proposals failures are notified by the dedicated
    // proposal_generation_failed path in the worker handler (which has access
    // to job.attemptsMade so the notification fires only on the final attempt,
    // not every retry). Skip the generic job_failed notification here.
    if (entry.jobName === 'generate-proposals') return;
    if (!entry.repositoryId) return;
    const repository = await prisma.repository.findUnique({
      where: { id: entry.repositoryId },
      select: {
        fullName: true,
        connection: { select: { userId: true, accessTokenEnc: true, refreshTokenEnc: true } },
      },
    });
    if (!repository) return;
    const title = `Job failed: ${entry.jobName}`;
    const existing = await prisma.notification.findFirst({
      where: { userId: repository.connection.userId, kind: 'job_failed', readAt: null, title },
      select: { id: true },
    });
    if (existing) return;
    const secrets = await failureSecrets(repository.connection);
    await notify(repository.connection.userId, 'job_failed', {
      title,
      body: `${repository.fullName} — ${friendlyErrorMessage(redactSecrets(entry.message, secrets))}`,
    });
  } catch (err) {
    logger.error({ jobName: entry.jobName, err }, 'failed to notify job failure');
  }
}

// Scrubs a repository-scoped worker failure message against the owner's
// tokens/keys before it is PERSISTED (Repository.lastProposalError) and
// served by GET /repositories / rendered in the UI. Worker-level errors
// arrive raw (git clone URLs with embedded tokens, LLM client errors), so
// the stamp path needs the same failureSecrets scrub as the notification
// path. Never throws: on any lookup failure it falls back to scrubbing with
// the config-level MONITORED_SECRETS only (better than persisting raw).
export async function scrubRepositoryFailureMessage(
  repositoryId: string,
  message: string,
): Promise<string> {
  try {
    const repository = await prisma.repository.findUnique({
      where: { id: repositoryId },
      select: {
        connection: { select: { userId: true, accessTokenEnc: true, refreshTokenEnc: true } },
      },
    });
    if (!repository) return redactSecrets(message, [...MONITORED_SECRETS]);
    const secrets = await failureSecrets(repository.connection);
    return redactSecrets(message, secrets);
  } catch (err) {
    logger.error({ repositoryId, err }, 'failed to scrub repository failure message');
    return redactSecrets(message, [...MONITORED_SECRETS]);
  }
}

// Dedicated failure notification for generate-proposals jobs. Called from the
// worker handler ONLY on the final retry attempt (so transient failures that
// recover do not alarm the user). Deduped per repo: one unread
// proposal_generation_failed notification per repository at a time, so a broken
// LLM config cannot spam the bell on every 10-minute top-up cycle. The message
// is scrubbed against the owner's tokens/keys.
export async function notifyProposalGenerationFailure(
  repositoryId: string,
  message: string,
): Promise<void> {
  try {
    const repository = await prisma.repository.findUnique({
      where: { id: repositoryId },
      select: {
        fullName: true,
        connection: { select: { userId: true, accessTokenEnc: true, refreshTokenEnc: true } },
      },
    });
    if (!repository) return;
    const title = `Proposal generation failed: ${repository.fullName}`;
    const existing = await prisma.notification.findFirst({
      where: { userId: repository.connection.userId, kind: 'proposal_generation_failed', readAt: null, title },
      select: { id: true },
    });
    if (existing) return;
    const secrets = await failureSecrets(repository.connection);
    await notify(repository.connection.userId, 'proposal_generation_failed', {
      title,
      body: `${repository.fullName} — ${friendlyErrorMessage(redactSecrets(message, secrets))}`,
    });
  } catch (err) {
    logger.error({ repositoryId, err }, 'failed to notify proposal generation failure');
  }
}
