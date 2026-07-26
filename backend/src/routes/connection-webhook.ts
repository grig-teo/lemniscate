import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { encrypt } from '../lib/crypto.js';
import { generateWebhookSecret } from '../lib/notification-delivery.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { idParamsSchema } from './connection-schemas.js';

// Webhook configuration handlers for git connections: generate/rotate the
// shared secret used to verify inbound provider webhooks, expose the webhook
// URL for the user to register on GitHub/GitLab, and clear the secret.

function webhookUrl(connectionId: string): string {
  return `${config.BACKEND_URL}/api/webhooks/${connectionId}`;
}

async function ownedConnection(userId: string, id: string) {
  return prisma.gitConnection.findFirst({
    where: { id, userId },
    select: { id: true, webhookSecretEnc: true },
  });
}

// POST /connections/:id/webhook-config — generates a new webhook secret,
// stores it encrypted (never returns the encrypted value), and returns the
// webhook URL + plaintext secret for one-time display.
export async function configureWebhook(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid connection id');
  if (params === null) return;
  const connection = await ownedConnection(userId, params.id);
  if (!connection) return reply.code(404).send({ error: 'Connection not found' });

  const secret = generateWebhookSecret();
  await prisma.gitConnection.update({
    where: { id: connection.id },
    data: { webhookSecretEnc: encrypt(secret) },
  });
  return {
    webhookUrl: webhookUrl(connection.id),
    secret,
    message: 'Register this URL and secret on your git provider. The secret is shown only once.',
  };
}

// GET /connections/:id/webhook-config — returns the webhook URL and whether
// a secret is configured (never the secret itself).
export async function getWebhookConfig(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid connection id');
  if (params === null) return;
  const connection = await ownedConnection(userId, params.id);
  if (!connection) return reply.code(404).send({ error: 'Connection not found' });

  return {
    webhookUrl: webhookUrl(connection.id),
    hasSecret: connection.webhookSecretEnc !== null,
  };
}

// DELETE /connections/:id/webhook-config — clears the webhook secret so the
// receiver answers 401 (the 5-min pr-state-sync poller remains as fallback).
export async function deleteWebhookConfig(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid connection id');
  if (params === null) return;
  const { count } = await prisma.gitConnection.updateMany({
    where: { id: params.id, userId },
    data: { webhookSecretEnc: null },
  });
  if (count === 0) return reply.code(404).send({ error: 'Connection not found' });
  return reply.code(204).send();
}
