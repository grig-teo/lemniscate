import { createHmac, randomBytes } from 'node:crypto';
import { decrypt } from './crypto.js';
import { prisma } from './prisma.js';
import { assertPublicHttpUrl } from './url-safety.js';
import { errorMessage } from './utils.js';

// Single home for user-facing notifications of async agent events
// (AGENTS.md §6): every producer (PR opened in agent-run.ts, PR merged/
// closed in pr-state-sync.ts, job failures in agent-git.ts recordJobFailure)
// funnels through notify()/notifyTaskFailure() here. One Notification row is
// the source of truth; the optional per-user outbound webhook is a
// best-effort side effect that never blocks or fails the caller.

export const NOTIFICATION_KINDS = [
  'pr_opened',
  'pr_merged',
  'pr_closed',
  'run_failed',
  'budget_exceeded',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationPayload {
  title: string;
  body: string;
  taskId?: string;
  prUrl?: string;
}

export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_SIGNATURE_HEADER = 'x-lemniscate-signature';
export const WEBHOOK_EVENT_HEADER = 'x-lemniscate-event';

// ---------------------------------------------------------------------------
// Webhook signing (pure helpers — the route and tests share these)
// ---------------------------------------------------------------------------

export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

// HMAC-SHA256 over the exact request body, GitHub-style `sha256=<hex>`.
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Webhook delivery (best-effort; failures are logged, never thrown)
// ---------------------------------------------------------------------------

async function deliverWebhook(url: string, secret: string | null, body: string, kind: string) {
  // SSRF guard: the webhook URL is user-supplied (same rule as LLM base URLs).
  await assertPublicHttpUrl(url);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [WEBHOOK_EVENT_HEADER]: kind,
  };
  if (secret) headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(secret, body);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!response.ok) {
    console.warn(`webhook delivery failed: HTTP ${response.status} from ${url}`);
  }
}

async function fireUserWebhook(
  userId: string,
  kind: string,
  notification: Record<string, unknown>,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { webhookUrl: true, webhookSecretEnc: true },
  });
  if (!user?.webhookUrl) return;
  try {
    const secret = user.webhookSecretEnc ? decrypt(user.webhookSecretEnc) : null;
    await deliverWebhook(user.webhookUrl, secret, JSON.stringify(notification), kind);
  } catch (err) {
    console.warn(`webhook delivery failed for user ${userId}: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

// Writes the Notification row, then fires the user's webhook (best-effort).
// Never throws into the caller: a notification must not fail the job that
// produced it.
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
    await fireUserWebhook(userId, kind, notification as unknown as Record<string, unknown>);
  } catch (err) {
    console.error(`failed to record ${kind} notification for user ${userId}: ${errorMessage(err)}`);
  }
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
  const existing = await prisma.notification.findFirst({
    where: { taskId, kind, readAt: null },
    select: { id: true },
  });
  if (existing) return;
  const title = kind === 'budget_exceeded' ? 'Token budget exceeded' : 'Run failed';
  await notify(task.repository.connection.userId, kind, {
    title: `${title}: ${task.title}`,
    body: `${task.repository.fullName} — ${message}`,
    taskId,
  });
}
