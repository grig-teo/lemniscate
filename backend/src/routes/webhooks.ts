import type { FastifyPluginAsync } from 'fastify';
import { decrypt } from '../lib/crypto.js';
import { getProviderWebhookApi } from '../lib/git-providers/webhook-registry.js';
import type { ProviderName } from '../lib/git-providers/types.js';
import { applyTaskPrStateSafe, type TaskWithConnection } from '../lib/pr-merged-handler.js';
import { prisma } from '../lib/prisma.js';
import { enqueueAddressReview, enqueueMergeGate } from '../lib/proposal-scheduler.js';
import { reviewFeedbackSkipReason } from '../lib/review-feedback.js';
import { getRedisClient } from '../lib/redis.js';
import type { WebhookEvent } from '../lib/git-providers/webhook-types.js';
import { fireEventTrigger } from '../lib/event-trigger-handler.js';

// Inbound git-provider webhook receiver: POST /api/webhooks/:connectionId.
//
// No session cookie — the provider's HMAC signature (GitHub X-Hub-Signature-256)
// or shared-secret token (GitLab X-Gitlab-Token) is the credential. Every code
// path must reject before any DB write when verification fails (AGENTS.md §6).
//
// Registered outside the requireAuth scope, with its own strict rate-limit
// bucket. Replay attacks are mitigated by deduping on the provider delivery ID
// via a short-lived Redis SET NX.

const WEBHOOK_RATE_LIMIT = { max: 100, timeWindow: '1 minute' } as const;
const DEDUP_KEY_PREFIX = 'webhook:delivered:';
const DEDUP_TTL_SECONDS = 3600;

const webhookRoutes: FastifyPluginAsync = async (app) => {
  // Capture the raw body as a Buffer for HMAC verification. Scoped to this
  // plugin: other routes keep the default JSON parser. The handler parses
  // JSON itself after signature verification.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post(
    '/webhooks/:connectionId',
    { config: { rateLimit: WEBHOOK_RATE_LIMIT } },
    async (request, reply) => {
      const { connectionId } = request.params as { connectionId: string };
      const rawBody = request.body as Buffer;
      const headers = request.headers as Record<string, string | string[] | undefined>;

      const connection = await prisma.gitConnection.findUnique({
        where: { id: connectionId },
        select: { id: true, provider: true, webhookSecretEnc: true, disconnectedAt: true },
      });
      if (!connection) return reply.code(404).send({ error: 'connection not found' });

      const secret = resolveWebhookSecret(connection);
      if (!secret) return reply.code(401).send({ error: 'webhook secret not configured' });

      const api = getProviderWebhookApi(connection.provider as ProviderName);
      if (!api) return reply.code(501).send({ error: 'webhooks not supported for this provider' });

      if (!api.verifySignature(headers, rawBody, secret)) {
        return reply.code(401).send({ error: 'invalid signature' });
      }

      const payload = parseJsonSafe(rawBody);
      const event = api.parseEvent(payload, headers);
      if (!event) return reply.code(200).send({ ok: true, event: 'ignored' });

      if (await isReplay(event.deliveryId)) {
        return reply.code(200).send({ ok: true, event: 'duplicate' });
      }

      return dispatchEvent(connection.id, event);
    },
  );
};

function resolveWebhookSecret(connection: { webhookSecretEnc: string | null }): string | null {
  if (!connection.webhookSecretEnc) return null;
  try {
    return decrypt(connection.webhookSecretEnc);
  } catch {
    return null;
  }
}

function parseJsonSafe(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
}

async function isReplay(deliveryId: string | null): Promise<boolean> {
  if (!deliveryId) return false;
  const redis = getRedisClient();
  const result = await redis.set(
    `${DEDUP_KEY_PREFIX}${deliveryId}`,
    '1',
    'EX',
    DEDUP_TTL_SECONDS,
    'NX',
  );
  return result === null;
}

async function dispatchEvent(connectionId: string, event: WebhookEvent) {
  const task = await findAwaitingTask(connectionId, event.repoFullName, event.headBranch);
  if (event.kind === 'pr_review_comment') {
    return dispatchReviewComment(event, task);
  }
  if (task) {
    const prStateResult = await dispatchPrStateEvent(event, task);
    if (prStateResult) return prStateResult;
  }

  // Event-driven triggers (ci_failed, issue_opened): checked after the existing
  // PR-state dispatch so both paths can fire for the same event if needed.
  const triggerResult = await fireEventTrigger(event);
  if (triggerResult.fired) {
    return { ok: true, event: event.kind };
  }
  return { ok: true, event: task ? event.kind : 'no_task' };
}

// A human PR review comment on an awaiting task's branch enqueues the
// address-review job — gated per repo by autoAddressReview, self-comments
// and already-addressed ids are ignored (the job re-checks everything at
// execution time; this layer only avoids queue noise).
async function dispatchReviewComment(
  event: WebhookEvent,
  task: TaskWithConnection | null,
): Promise<{ ok: true; event: string }> {
  const comment = event.reviewComment;
  if (!comment || !task) return { ok: true, event: 'no_task' };
  const skip = reviewFeedbackSkipReason({
    taskStatus: task.status,
    branchName: task.branchName,
    lastAddressedReviewId: task.lastAddressedReviewId,
    autoAddressReview: task.repository.autoAddressReview,
    connectionUsername: task.repository.connection.username,
    comment,
  });
  if (skip) return { ok: true, event: `pr_review_comment_${skip}` };
  await enqueueAddressReview(task.id, comment);
  return { ok: true, event: 'pr_review_comment' };
}

/** Dispatches PR-state transitions (pr_merged, pr_closed, ci_status) and kicks
 * the merge gate for ci_failed on an awaiting task's branch. */
async function dispatchPrStateEvent(
  event: WebhookEvent,
  task: TaskWithConnection,
): Promise<{ ok: true; event: string } | null> {
  if (event.kind === 'pr_merged') {
    await applyTaskPrStateSafe(task, 'merged', 'webhook');
    return { ok: true, event: 'pr_merged' };
  }
  if (event.kind === 'pr_closed') {
    await applyTaskPrStateSafe(task, 'closed', 'webhook');
    return { ok: true, event: 'pr_closed' };
  }
  if (event.kind === 'ci_status') {
    await enqueueMergeGate(task.id);
    return { ok: true, event: 'ci_status' };
  }
  // A failed check on an awaiting task's branch is still a CI signal: kick the
  // merge gate so its CI-fix loop runs. Falls through (returns null) so the
  // event trigger can also fire for the same delivery.
  if (event.kind === 'ci_failed') {
    await enqueueMergeGate(task.id);
  }
  return null;
}

// The repository lookup is scoped to the verified connection: two users can
// connect the same forge host (or identically-named repos on different
// hosts), and an event verified for connection A must never dispatch a task
// belonging to connection B.
async function findAwaitingTask(
  connectionId: string,
  repoFullName: string,
  headBranch: string,
): Promise<TaskWithConnection | null> {
  return prisma.task.findFirst({
    where: {
      status: { in: ['awaiting_review', 'reviewing_code'] },
      branchName: headBranch,
      repository: { fullName: repoFullName, connectionId },
    },
    include: { repository: { include: { connection: true } } },
  });
}

export default webhookRoutes;
