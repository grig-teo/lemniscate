import { createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { decrypt } from './crypto.js';
import { prisma } from './prisma.js';
import { getAgentTasksQueue } from './queue.js';
import { assertPublicHttpUrl } from './url-safety.js';
import { DeliveryError, sendEmail } from './notification-email.js';
import { logger } from './logger.js';
import { errorMessage, redactSecrets } from './utils.js';

// Outbound delivery for user notifications (AGENTS.md §6 single home):
// dispatchToChannels() fans an event out to the user's enabled channels by
// writing one NotificationDelivery audit row each and enqueueing a
// BullMQ-retried 'notification-delivery' job; the worker runs
// deliverNotification() (HMAC-signed webhook POST, or email via the optional
// SMTP_* config). sendTestNotification() is the synchronous one-shot used by
// the settings UI "Test" button. Delivery must never fail the producer job.

export const DELIVERY_JOB_NAME = 'notification-delivery';
export const DELIVERY_MAX_ATTEMPTS = 3;
export const DELIVERY_BACKOFF_MS = 5_000;
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_SIGNATURE_HEADER = 'x-lemniscate-signature';
export const WEBHOOK_EVENT_HEADER = 'x-lemniscate-event';

export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

// HMAC-SHA256 over the exact request body, GitHub-style `sha256=<hex>`.
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

const DELIVERY_JOB_OPTIONS = {
  attempts: DELIVERY_MAX_ATTEMPTS,
  backoff: { type: 'exponential' as const, delay: DELIVERY_BACKOFF_MS },
  removeOnComplete: true,
  removeOnFailed: 50,
};

export interface ChannelEventPayload {
  title: string;
  body: string;
  taskId?: string;
  prUrl?: string;
}

// ---------------------------------------------------------------------------
// Dispatch (producer side — best-effort, never throws)
// ---------------------------------------------------------------------------

function redactedPayload(
  event: string,
  payload: ChannelEventPayload,
  notificationId: string | null,
  secret: string | null,
): Record<string, unknown> {
  const secrets = secret ? [secret] : [];
  return {
    event,
    title: redactSecrets(payload.title, secrets),
    body: redactSecrets(payload.body, secrets),
    taskId: payload.taskId ?? null,
    prUrl: payload.prUrl ?? null,
    notificationId,
  };
}

async function enqueueChannelDelivery(
  setting: { id: string; secretEnc: string | null },
  event: string,
  payload: ChannelEventPayload,
  notificationId: string | null,
): Promise<void> {
  const secret = setting.secretEnc ? decrypt(setting.secretEnc) : null;
  const body = redactedPayload(event, payload, notificationId, secret);
  // Single write: the audit row always holds the full payload. The delivery
  // id does not exist yet — it is stamped into the outbound body at
  // delivery time (stampedBody), never stored as an empty placeholder.
  const delivery = await prisma.notificationDelivery.create({
    data: {
      settingId: setting.id,
      notificationId,
      event,
      status: 'queued',
      payload: JSON.stringify(body),
    },
  });
  await getAgentTasksQueue().add(DELIVERY_JOB_NAME, { deliveryId: delivery.id }, DELIVERY_JOB_OPTIONS);
}

// Fans the event out to every enabled channel of the user subscribed to it.
// Errors are logged, never propagated: a broken channel must not fail the
// job that produced the event.
export async function dispatchToChannels(
  userId: string,
  event: string,
  payload: ChannelEventPayload,
  notificationId: string | null,
): Promise<void> {
  try {
    const settings = await prisma.notificationSetting.findMany({
      where: { userId, enabled: true, events: { has: event } },
    });
    for (const setting of settings) {
      await enqueueChannelDelivery(setting, event, payload, notificationId);
    }
  } catch (err) {
    logger.error({ event, userId, err }, 'failed to dispatch notification');
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function postWebhook(target: string, secret: string | null, body: string, event: string): Promise<number> {
  // SSRF guard: the webhook URL is user-supplied (same rule as LLM base
  // URLs). Re-checked at delivery time, not only at setting-save time.
  await assertPublicHttpUrl(target);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [WEBHOOK_EVENT_HEADER]: event,
  };
  if (secret) headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(secret, body);
  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers,
      body,
      // redirect:'manual' closes the redirect SSRF bypass: a public URL
      // passing the guard must not be able to 302 fetch() into an internal
      // address. A 3xx is simply a failed delivery (retried by BullMQ).
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DeliveryError(errorMessage(err));
  }
  if (!response.ok) {
    throw new DeliveryError(`webhook responded with HTTP ${response.status}`, response.status);
  }
  return response.status;
}

async function transportFor(
  setting: { channel: string; target: string; secretEnc: string | null },
  body: string,
  event: string,
): Promise<number | null> {
  if (setting.channel === 'email') {
    await sendEmail(setting.target, JSON.parse(body) as Record<string, unknown>);
    return null;
  }
  const secret = setting.secretEnc ? decrypt(setting.secretEnc) : null;
  return postWebhook(setting.target, secret, body, event);
}

// ---------------------------------------------------------------------------
// Delivery (worker side)
// ---------------------------------------------------------------------------

async function recordOutcome(
  deliveryId: string,
  outcome: { status: string; attempts: number; lastStatusCode: number | null; lastError: string | null },
): Promise<void> {
  await prisma.notificationDelivery.update({ where: { id: deliveryId }, data: outcome });
}

// Stamps the delivery id into the outbound body. The stored payload is
// written in a single create before the id exists (see
// enqueueChannelDelivery), so the receiver gets the correlation id from the
// job data at delivery time; the signed body is this stamped form.
function stampedBody(payload: string, deliveryId: string): string {
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, deliveryId });
}

// Executes one delivery attempt. Retries are BullMQ's: a failure with
// attempts remaining rethrows so the job is rescheduled with backoff; the
// final attempt marks the row 'failed' and completes (the audit row, not
// the queue, is the source of truth for the terminal state).
export async function deliverNotification(deliveryId: string, attemptsMade: number): Promise<void> {
  const delivery = await prisma.notificationDelivery.findUnique({
    where: { id: deliveryId },
    include: { setting: true },
  });
  if (!delivery) return;
  const attempts = attemptsMade + 1;
  let statusCode: number | null;
  try {
    statusCode = await transportFor(
      delivery.setting,
      stampedBody(delivery.payload, delivery.id),
      delivery.event,
    );
  } catch (err) {
    const failureStatus = err instanceof DeliveryError ? err.statusCode : null;
    if (delivery.setting.channel === 'email' && !config.SMTP_HOST) {
      await recordOutcome(deliveryId, {
        status: 'skipped',
        attempts,
        lastStatusCode: null,
        lastError: errorMessage(err),
      });
      return;
    }
    const final = attempts >= DELIVERY_MAX_ATTEMPTS;
    await recordOutcome(deliveryId, {
      status: final ? 'failed' : 'queued',
      attempts,
      lastStatusCode: failureStatus,
      lastError: errorMessage(err),
    });
    if (!final) throw err;
    return;
  }
  await recordOutcome(deliveryId, {
    status: 'delivered',
    attempts,
    lastStatusCode: statusCode,
    lastError: null,
  });
}

// One synchronous attempt for the settings UI "Test" button. Returns null
// for a foreign/unknown setting (ownership scoping), otherwise the outcome;
// every attempt is written to the audit log as event 'test'.
export async function sendTestNotification(
  settingId: string,
  userId: string,
): Promise<{ ok: boolean; statusCode: number | null; error: string | null } | null> {
  const setting = await prisma.notificationSetting.findUnique({ where: { id: settingId, userId } });
  if (!setting) return null;
  const body = JSON.stringify({
    event: 'test',
    title: 'Lemniscate test notification',
    body: 'Channel test from the Lemniscate notification settings.',
    taskId: null,
    prUrl: null,
    notificationId: null,
    deliveryId: null,
  });
  let statusCode: number | null;
  try {
    statusCode = await transportFor(setting, body, 'test');
  } catch (err) {
    const failureStatus = err instanceof DeliveryError ? err.statusCode : null;
    await prisma.notificationDelivery.create({
      data: {
        settingId,
        event: 'test',
        status: 'failed',
        attempts: 1,
        lastStatusCode: failureStatus,
        lastError: errorMessage(err),
        payload: body,
      },
    });
    return { ok: false, statusCode: failureStatus, error: errorMessage(err) };
  }
  await prisma.notificationDelivery.create({
    data: {
      settingId,
      event: 'test',
      status: 'delivered',
      attempts: 1,
      lastStatusCode: statusCode,
      lastError: null,
      payload: body,
    },
  });
  return { ok: true, statusCode, error: null };
}
