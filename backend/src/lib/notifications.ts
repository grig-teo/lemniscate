import { prisma } from './prisma.js';
import { dispatchToChannels } from './notification-delivery.js';
import { errorMessage } from './utils.js';

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
  'task_completed',
  'merge_gate_failed',
  'job_failed',
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
    console.error(`failed to record ${kind} notification for user ${userId}: ${errorMessage(err)}`);
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

// Task-scoped failure entry point used by recordJobFailure (agent-git.ts):
// resolves the owning user from the task, maps TokenBudgetExceededError to
// its own kind, and dedupes against an unread notification for the same
// task+kind so BullMQ retries of a review/merge job cannot spam the user.
export async function notifyTaskFailure(
  taskId: string,
  errorKind: string,
  message: string,
): Promise<void> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      title: true,
      repository: { select: { fullName: true, connection: { select: { userId: true } } } },
    },
  });
  if (!task) return;
  const kind: NotificationKind =
    errorKind === 'TokenBudgetExceededError' ? 'budget_exceeded' : 'run_failed';
  const title = kind === 'budget_exceeded' ? 'Token budget exceeded' : 'Run failed';
  await notifyOncePerTask(task.repository.connection.userId, kind, {
    title: `${title}: ${task.title}`,
    body: `${task.repository.fullName} — ${message}`,
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
// task-scoped failures reuse the run_failed path (deduped against the
// in-run recordJobFailure notification); repository-scoped failures (the
// scheduled 'generate-proposals' runs) notify the repo owner as job_failed,
// deduped per unread job name so a broken LLM config cannot spam every cycle.
export async function notifyJobFailure(entry: JobFailureNotification): Promise<void> {
  try {
    if (entry.taskId) {
      await notifyTaskFailure(entry.taskId, entry.errorKind, entry.message);
      return;
    }
    if (!entry.repositoryId) return;
    const repository = await prisma.repository.findUnique({
      where: { id: entry.repositoryId },
      select: { fullName: true, connection: { select: { userId: true } } },
    });
    if (!repository) return;
    const title = `Job failed: ${entry.jobName}`;
    const existing = await prisma.notification.findFirst({
      where: { userId: repository.connection.userId, kind: 'job_failed', readAt: null, title },
      select: { id: true },
    });
    if (existing) return;
    await notify(repository.connection.userId, 'job_failed', {
      title,
      body: `${repository.fullName} — ${entry.message}`,
    });
  } catch (err) {
    console.error(`failed to notify job failure (${entry.jobName}): ${errorMessage(err)}`);
  }
}
