import type { FastifyReply, FastifyRequest } from 'fastify';
import { encrypt } from '../lib/crypto.js';
import {
  fetchProviderProfile,
  ProviderError,
  type ProviderName,
} from '../lib/git-providers.js';
import { prisma } from '../lib/prisma.js';
import {
  syncConnectionByIdBestEffort,
  syncConnectionRepositories,
} from '../lib/repo-sync.js';
import { assertPublicHttpUrl } from '../lib/url-safety.js';
import { errorMessage } from '../lib/utils.js';
import {
  AUTH_COOKIE,
  authenticatedUserId,
  bumpSessionVersion,
  setAuthCookie,
  verifyAuthToken,
} from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import { findPatIdentity, reactivatePatIdentity, upsertAuthenticatedConnection } from './connection-pat-store.js';
import { connectBodySchema, connectionSelect, idParamsSchema } from './connection-schemas.js';

// Connection handlers: list, PAT connect (doubling as first-time login),
// soft disconnect, and repository sync.

// Like requireAuth but never rejects: sets request.userId when the session
// cookie is present, valid and unrevoked; leaves it undefined otherwise.
// Used by POST /connections, which doubles as GitVerse-first login.
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = request.cookies[AUTH_COOKIE];
  if (!token) return;
  const payload = verifyAuthToken(token);
  if (!payload) return;
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (user && user.sessionVersion === payload.sv) {
    request.userId = user.id;
  }
}

// Self-hosted GitVerse instances must be https and publicly routable — the
// backend will call this URL with the user's PAT (SSRF guard).
async function validGitverseBaseUrl(
  baseUrl: string,
  reply: FastifyReply,
): Promise<boolean> {
  if (!baseUrl.startsWith('https://')) {
    await reply.code(400).send({ error: 'gitverse baseUrl must use https' });
    return false;
  }
  try {
    await assertPublicHttpUrl(baseUrl);
    return true;
  } catch (err) {
    await reply.code(400).send({ error: `gitverse baseUrl rejected: ${errorMessage(err)}` });
    return false;
  }
}

// Validates the token against the provider. Returns the provider username,
// or null after sending a 400 on ProviderError.
async function validatedUsername(
  provider: ProviderName,
  token: string,
  baseUrl: string | undefined,
  reply: FastifyReply,
): Promise<string | null> {
  try {
    const profile = await fetchProviderProfile(provider, token, baseUrl);
    return profile.username;
  } catch (err) {
    if (err instanceof ProviderError) {
      void reply.code(400).send({ error: `Token validation failed: ${err.message}` });
      return null;
    }
    throw err;
  }
}

// Unauthenticated path: the PAT is the credential — find the user behind
// this connection and start a session. No open registration: an unknown PAT
// identity is rejected with 401 instead of creating an account.
async function connectByPatIdentity(
  provider: ProviderName,
  username: string,
  baseUrl: string | undefined,
  accessTokenEnc: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const existing = await findPatIdentity(provider, username, baseUrl);
  if (!existing) {
    return reply.code(401).send({ error: 'No account matches this token' });
  }
  const connection = await reactivatePatIdentity(existing.id, accessTokenEnc);
  await setAuthCookie(reply, existing.userId);
  await syncConnectionByIdBestEffort(connection.id, request.log);
  return reply.code(200).send({ connection });
}

export async function listConnections(request: FastifyRequest) {
  const userId = authenticatedUserId(request);
  const connections = await prisma.gitConnection.findMany({
    where: { userId },
    select: {
      ...connectionSelect,
      _count: { select: { repositories: true } },
    },
    orderBy: { provider: 'asc' },
  });
  return { connections };
}

// PAT-based connect (the only option for GitVerse; also works for
// GitHub/GitLab). Validates the token against the provider before storing.
//
// Doubles as login when no session exists: without a valid auth cookie the
// PAT identifies the user — the connection must already exist (this route
// never creates accounts) and a JWT session cookie is set. With a session it
// attaches the connection to the authenticated user as before.
export async function connectWithPat(request: FastifyRequest, reply: FastifyReply) {
  const data = parseOrReply(connectBodySchema, request.body, reply, 'Invalid body', {
    includeIssues: true,
  });
  if (data === null) return;
  const { provider, token, baseUrl } = data;
  if (provider !== 'gitverse' && baseUrl) {
    return reply.code(400).send({ error: 'baseUrl is only supported for gitverse connections' });
  }
  if (provider === 'gitverse' && baseUrl && !(await validGitverseBaseUrl(baseUrl, reply))) {
    return;
  }

  const username = await validatedUsername(provider, token, baseUrl, reply);
  if (username === null) return;
  const accessTokenEnc = encrypt(token);

  if (request.userId) {
    const result = await upsertAuthenticatedConnection(
      request.userId,
      provider,
      username,
      baseUrl,
      accessTokenEnc,
    );
    if (result === null) {
      return reply
        .code(409)
        .send({ error: 'This git account is already connected by another user' });
    }
    await syncConnectionByIdBestEffort(result.connection.id, request.log);
    return reply.code(result.created ? 201 : 200).send({ connection: result.connection });
  }
  return connectByPatIdentity(provider, username, baseUrl, accessTokenEnc, request, reply);
}

export async function deleteConnection(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid connection id');
  if (params === null) return;
  // Soft disconnect: the connection row (with its repositories, tasks, and
  // configuration) is kept so reconnecting restores everything in place —
  // only the stored tokens are scrubbed.
  const { count } = await prisma.gitConnection.updateMany({
    where: { id: params.id, userId },
    data: {
      disconnectedAt: new Date(),
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
    },
  });
  if (count === 0) {
    return reply.code(404).send({ error: 'Connection not found' });
  }
  // Losing the last ACTIVE git connection ends the session. The account is
  // never lost: the tombstoned row lets the next login land on the same user.
  const remaining = await prisma.gitConnection.count({
    where: { userId, disconnectedAt: null },
  });
  if (remaining === 0) {
    await bumpSessionVersion(userId);
  }
  return reply.code(204).send();
}

// Pulls the provider's repo list and upserts Repository rows keyed by
// (connectionId, externalId).
export async function syncConnectionRepos(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid connection id');
  if (params === null) return;

  const connection = await prisma.gitConnection.findFirst({
    where: { id: params.id, userId },
  });
  if (!connection) {
    return reply.code(404).send({ error: 'Connection not found' });
  }

  try {
    return await syncConnectionRepositories(connection);
  } catch (err) {
    if (err instanceof ProviderError) {
      return reply.code(502).send({ error: `Failed to list repositories: ${err.message}` });
    }
    throw err;
  }
}
