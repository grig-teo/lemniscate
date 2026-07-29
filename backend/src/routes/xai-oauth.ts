import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { encrypt } from '../lib/crypto.js';
import {
  accessTokenExpiresAt,
  discoveryUrls,
  pollDeviceTokenOnce,
  requestDeviceCode,
  XAI_DEFAULT_BASE_URL,
  XAI_DEFAULT_CODING_MODEL,
  type OAuthTokenPair,
} from '../lib/xai-oauth.js';
import { findProviderPreset } from '../lib/llm-providers.js';
import { prisma } from '../lib/prisma.js';
import { getRedisClient } from '../lib/redis.js';
import { errorMessage } from '../lib/utils.js';
import { requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// xAI Grok OAuth device-code flow for Settings → LLM configs.
// POST /start → verification URL + code; POST /poll until authorized;
// POST /complete creates an LlmConfig with authType=oauth (default model
// grok-4.5). Tokens sit encrypted in Redis between authorize and complete.

const OAUTH_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;
const SESSION_PREFIX = 'xai-oauth:';
const SESSION_TTL_SECONDS = 20 * 60;

type PendingChallenge = {
  phase: 'pending';
  userId: string;
  deviceCode: string;
  tokenEndpoint: string;
  interval: number;
  expiresAtMs: number;
};

type AuthorizedSession = {
  phase: 'authorized';
  userId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  tokenEndpoint: string;
  tokenExpiresAt: string | null;
};

type StoredSession = PendingChallenge | AuthorizedSession;

function sessionKey(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

async function writeSession(sessionId: string, data: StoredSession, ttl = SESSION_TTL_SECONDS) {
  await getRedisClient().set(sessionKey(sessionId), JSON.stringify(data), 'EX', ttl);
}

async function readSession(sessionId: string): Promise<StoredSession | null> {
  const raw = await getRedisClient().get(sessionKey(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

async function deleteSession(sessionId: string): Promise<void> {
  await getRedisClient().del(sessionKey(sessionId));
}

function newSessionId(): string {
  return randomBytes(24).toString('base64url');
}

function remainingTtlSeconds(expiresAtMs: number): number {
  return Math.max(30, Math.ceil((expiresAtMs - Date.now()) / 1000));
}

async function startOauth(request: FastifyRequest, reply: FastifyReply) {
  try {
    const [{ tokenEndpoint }, challenge] = await Promise.all([
      discoveryUrls(),
      requestDeviceCode(),
    ]);
    const sessionId = newSessionId();
    const expiresAtMs = Date.now() + challenge.expiresIn * 1000;
    await writeSession(
      sessionId,
      {
        phase: 'pending',
        userId: request.userId!,
        deviceCode: challenge.deviceCode,
        tokenEndpoint,
        interval: challenge.interval,
        expiresAtMs,
      },
      remainingTtlSeconds(expiresAtMs),
    );
    return {
      sessionId,
      userCode: challenge.userCode,
      verificationUrl: challenge.verificationUrl,
      expiresIn: challenge.expiresIn,
      interval: challenge.interval,
      defaultModel: XAI_DEFAULT_CODING_MODEL,
      models: findProviderPreset('grok')?.models ?? [XAI_DEFAULT_CODING_MODEL],
    };
  } catch (err) {
    return reply.code(502).send({ error: errorMessage(err) });
  }
}

const sessionBody = z.object({ sessionId: z.string().min(1).max(100) });

async function pollOauth(request: FastifyRequest, reply: FastifyReply) {
  const body = parseOrReply(sessionBody, request.body, reply, 'Invalid request body');
  if (body === null) return;
  const session = await readSession(body.sessionId);
  if (!session || session.userId !== request.userId) {
    return reply.code(404).send({ error: 'OAuth session not found or expired' });
  }
  if (session.phase === 'authorized') {
    return { status: 'authorized' as const };
  }
  if (Date.now() > session.expiresAtMs) {
    await deleteSession(body.sessionId);
    return reply.code(410).send({ error: 'Authorization timed out — start again' });
  }
  try {
    const result = await pollDeviceTokenOnce(session.tokenEndpoint, session.deviceCode);
    if (result.status === 'pending') return { status: 'pending' as const };
    if (result.status === 'slow_down') {
      return { status: 'slow_down' as const, interval: session.interval + 1 };
    }
    if (result.status === 'error') {
      await deleteSession(body.sessionId);
      return reply.code(400).send({ error: result.message });
    }
    await storeAuthorizedTokens(body.sessionId, session, result.tokens);
    return { status: 'authorized' as const };
  } catch (err) {
    return reply.code(502).send({ error: errorMessage(err) });
  }
}

async function storeAuthorizedTokens(
  sessionId: string,
  session: PendingChallenge,
  tokens: OAuthTokenPair,
): Promise<void> {
  const expiresAt = accessTokenExpiresAt(tokens.accessToken);
  await writeSession(
    sessionId,
    {
      phase: 'authorized',
      userId: session.userId,
      accessTokenEnc: encrypt(tokens.accessToken),
      refreshTokenEnc: encrypt(tokens.refreshToken),
      tokenEndpoint: session.tokenEndpoint,
      tokenExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    },
    remainingTtlSeconds(session.expiresAtMs),
  );
}

const completeBody = z.object({
  sessionId: z.string().min(1).max(100),
  model: z.string().min(1).max(200).default(XAI_DEFAULT_CODING_MODEL),
  name: z.string().min(1).max(100).optional(),
  isDefault: z.boolean().optional(),
});

async function completeOauth(request: FastifyRequest, reply: FastifyReply) {
  const body = parseOrReply(completeBody, request.body, reply, 'Invalid request body', {
    includeIssues: true,
    request,
  });
  if (body === null) return;
  const session = await readSession(body.sessionId);
  if (!session || session.userId !== request.userId) {
    return reply.code(404).send({ error: 'OAuth session not found or expired' });
  }
  if (session.phase !== 'authorized') {
    return reply.code(409).send({ error: 'Authorization is not complete yet' });
  }
  const preset = findProviderPreset('grok');
  const model = body.model.trim() || XAI_DEFAULT_CODING_MODEL;
  const isDefault = body.isDefault ?? true;
  const created = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.llmConfig.updateMany({
        where: { userId: request.userId!, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.llmConfig.create({
      data: {
        userId: request.userId!,
        name: body.name?.trim() || 'Grok (xAI OAuth)',
        baseUrl: preset?.baseUrl ?? XAI_DEFAULT_BASE_URL,
        apiKeyEnc: session.accessTokenEnc,
        model,
        apiPattern: 'openai',
        provider: 'grok',
        authType: 'oauth',
        refreshTokenEnc: session.refreshTokenEnc,
        tokenExpiresAt: session.tokenExpiresAt ? new Date(session.tokenExpiresAt) : null,
        oauthTokenEndpoint: session.tokenEndpoint,
        maxTokens: preset?.maxTokens ?? 8192,
        contextWindow: preset?.contextWindow ?? 256_000,
        requestsPerMinute: 60,
        isDefault,
        enabled: true,
      },
    });
  });
  await deleteSession(body.sessionId);
  const { apiKeyEnc: _a, refreshTokenEnc: _r, ...rest } = created;
  return reply.code(201).send({
    ...rest,
    hasApiKey: true,
    authType: created.authType,
  });
}

export default async function xaiOauthRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.post('/start', { config: { rateLimit: OAUTH_RATE_LIMIT } }, startOauth);
  app.post('/poll', { config: { rateLimit: OAUTH_RATE_LIMIT } }, pollOauth);
  app.post('/complete', { config: { rateLimit: OAUTH_RATE_LIMIT } }, completeOauth);
}
