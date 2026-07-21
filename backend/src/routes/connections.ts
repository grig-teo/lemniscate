import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { GitConnection, Prisma } from '@prisma/client';
import { z } from 'zod';
import { encrypt } from '../lib/crypto.js';
import {
  fetchProviderProfile,
  getProviderClient,
  ProviderError,
  type CreateRepoInput,
  type ProviderName,
} from '../lib/git-providers.js';
import { prisma } from '../lib/prisma.js';
import {
  syncConnectionByIdBestEffort,
  syncConnectionRepositories,
} from '../lib/repo-sync.js';
import {
  AUTH_COOKIE,
  authenticatedUserId,
  requireAuth,
  setAuthCookie,
  verifyAuthToken,
} from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// Never leak the encrypted (or decrypted) token to clients.
const connectionSelect = {
  id: true,
  provider: true,
  baseUrl: true,
  username: true,
} as const;

const connectBodySchema = z.object({
  provider: z.enum(['github', 'gitverse', 'gitlab', 'gitee']),
  token: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

// POST /connections/:id/repositories body. Exported for tests.
export const createRepoBodySchema = z.object({
  name: z.string().min(1).max(100),
  private: z.boolean().optional(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });

// Like requireAuth but never rejects: sets request.userId when the session
// cookie is present and valid, leaves it undefined otherwise. Used by
// POST /connections, which doubles as GitVerse-first login.
async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = request.cookies[AUTH_COOKIE];
  if (!token) return;
  try {
    const userId = verifyAuthToken(token);
    if (!userId) return;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      request.userId = user.id;
    }
  } catch {
    // Invalid/expired token: treat as unauthenticated.
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

type ConnectionView = Prisma.GitConnectionGetPayload<{ select: typeof connectionSelect }>;

// Authenticated path: the connection belongs to the session user.
async function upsertAuthenticatedConnection(
  userId: string,
  provider: ProviderName,
  username: string,
  baseUrl: string | undefined,
  accessTokenEnc: string,
): Promise<{ connection: ConnectionView; created: boolean }> {
  const existing = await prisma.gitConnection.findFirst({
    where: { userId, provider, username, baseUrl: baseUrl ?? null },
  });
  if (existing) {
    const connection = await prisma.gitConnection.update({
      where: { id: existing.id },
      // A PAT replaces any OAuth tokens: clear the refresh flow's fields.
      data: { accessTokenEnc, tokenType: 'pat', refreshTokenEnc: null, tokenExpiresAt: null },
      select: connectionSelect,
    });
    return { connection, created: false };
  }
  const connection = await prisma.gitConnection.create({
    data: { userId, provider, username, baseUrl: baseUrl ?? null, accessTokenEnc },
    select: connectionSelect,
  });
  return { connection, created: true };
}

// Unauthenticated path: the PAT is the credential — find or create the user
// behind this connection and start a session.
async function connectByPatIdentity(
  provider: ProviderName,
  username: string,
  baseUrl: string | undefined,
  accessTokenEnc: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const existing = await prisma.gitConnection.findFirst({
    where: { provider, username, baseUrl: baseUrl ?? null },
  });
  if (existing) {
    const connection = await prisma.gitConnection.update({
      where: { id: existing.id },
      // A PAT replaces any OAuth tokens: clear the refresh flow's fields.
      data: { accessTokenEnc, tokenType: 'pat', refreshTokenEnc: null, tokenExpiresAt: null },
      select: connectionSelect,
    });
    setAuthCookie(reply, existing.userId);
    await syncConnectionByIdBestEffort(connection.id, request.log);
    return reply.code(200).send({ connection });
  }
  const user = await prisma.user.create({
    data: {
      gitConnections: {
        create: { provider, username, baseUrl: baseUrl ?? null, accessTokenEnc },
      },
    },
    include: { gitConnections: { select: connectionSelect } },
  });
  setAuthCookie(reply, user.id);
  const connection = user.gitConnections[0];
  if (connection) {
    await syncConnectionByIdBestEffort(connection.id, request.log);
  }
  return reply.code(201).send({ connection });
}

async function listConnections(request: FastifyRequest) {
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
// PAT identifies the user — the connection (and, on first use, the user) is
// found or created and a JWT session cookie is set. With a session it
// attaches the connection to the authenticated user as before.
async function connectWithPat(request: FastifyRequest, reply: FastifyReply) {
  const data = parseOrReply(connectBodySchema, request.body, reply, 'Invalid body', {
    includeIssues: true,
  });
  if (data === null) return;
  const { provider, token, baseUrl } = data;
  if (provider !== 'gitverse' && baseUrl) {
    return reply.code(400).send({ error: 'baseUrl is only supported for gitverse connections' });
  }

  const username = await validatedUsername(provider, token, baseUrl, reply);
  if (username === null) return;
  const accessTokenEnc = encrypt(token);

  if (request.userId) {
    const { connection, created } = await upsertAuthenticatedConnection(
      request.userId,
      provider,
      username,
      baseUrl,
      accessTokenEnc,
    );
    await syncConnectionByIdBestEffort(connection.id, request.log);
    return reply.code(created ? 201 : 200).send({ connection });
  }
  return connectByPatIdentity(provider, username, baseUrl, accessTokenEnc, request, reply);
}

async function deleteConnection(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid connection id');
  if (params === null) return;
  // Repositories cascade-delete with the connection.
  const { count } = await prisma.gitConnection.deleteMany({
    where: { id: params.id, userId },
  });
  if (count === 0) {
    return reply.code(404).send({ error: 'Connection not found' });
  }
  return reply.code(204).send();
}

// Pulls the provider's repo list and upserts Repository rows keyed by
// (connectionId, externalId).
async function syncConnectionRepos(request: FastifyRequest, reply: FastifyReply) {
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

// Creates the repo on the provider, then re-syncs so the Repository row
// exists before the response returns.
async function createAndSyncRepo(
  connection: GitConnection,
  input: CreateRepoInput,
  reply: FastifyReply,
): Promise<FastifyReply> {
  try {
    const repository = await getProviderClient(connection).createRepo(input);
    const sync = await syncConnectionRepositories(connection);
    return reply.code(201).send({ repository, sync });
  } catch (err) {
    if (err instanceof ProviderError) {
      return reply.code(502).send({ error: `Failed to create repository: ${err.message}` });
    }
    throw err;
  }
}

// POST /connections/:id/repositories — creates a repository on the provider
// behind this connection (owner-checked like every other connection route).
async function createConnectionRepo(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const params = parseOrReply(idParamsSchema, request.params, reply, 'Invalid connection id');
  if (params === null) return;
  const data = parseOrReply(createRepoBodySchema, request.body, reply, 'Invalid body', {
    includeIssues: true,
  });
  if (data === null) return;

  const connection = await prisma.gitConnection.findFirst({
    where: { id: params.id, userId },
  });
  if (!connection) {
    return reply.code(404).send({ error: 'Connection not found' });
  }
  return createAndSyncRepo(connection, data, reply);
}

const connectionsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/connections', { preHandler: requireAuth }, listConnections);
  app.post('/connections', { preHandler: optionalAuth }, connectWithPat);
  app.delete('/connections/:id', { preHandler: requireAuth }, deleteConnection);
  app.post('/connections/:id/sync', { preHandler: requireAuth }, syncConnectionRepos);
  app.post('/connections/:id/repositories', { preHandler: requireAuth }, createConnectionRepo);
};

export default connectionsRoutes;
