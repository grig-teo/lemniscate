import type { FastifyPluginAsync } from 'fastify';
import { decrypt } from '../lib/crypto.js';
import { getProviderWebhookApi } from '../lib/git-providers/webhook-registry.js';
import type { ProviderName } from '../lib/git-providers/types.js';
import { applyTaskPrStateSafe, type TaskWithConnection } from '../lib/pr-merged-handler.js';
import { prisma } from '../lib/prisma.js';
import { enqueueMergeGate } from '../lib/proposal-scheduler.js';
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

      return dispatchEvent(event);
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

async function dispatchEvent(event: WebhookEvent) {
  const task = await findAwaitingTask(event.repoFullName, event.headBranch);
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

/** Dispatches PR-state transitions (pr_merged, pr_closed, ci_status). */
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
  return null;
}

async function findAwaitingTask(
  repoFullName: string,
  headBranch: string,
): Promise<TaskWithConnection | null> {
  return prisma.task.findFirst({
    where: {
      status: { in: ['awaiting_review', 'reviewing_code'] },
      branchName: headBranch,
      repository: { fullName: repoFullName },
    },
    include: { repository: { include: { connection: true } } },
  });
}

export default webhookRoutes;
