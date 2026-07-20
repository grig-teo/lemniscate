import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { encrypt } from '../lib/crypto.js';
import {
  fetchProviderProfile,
  getProviderClient,
  ProviderError,
  type NormalizedRepo,
  type ProviderName,
} from '../lib/git-providers.js';
import { prisma } from '../lib/prisma.js';
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
  provider: z.enum(['github', 'gitverse', 'gitlab']),
  token: z.string().min(1),
  baseUrl: z.string().url().optional(),
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
      data: { accessTokenEnc, tokenType: 'pat' },
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
  reply: FastifyReply,
): Promise<FastifyReply> {
  const existing = await prisma.gitConnection.findFirst({
    where: { provider, username, baseUrl: baseUrl ?? null },
  });
  if (existing) {
    const connection = await prisma.gitConnection.update({
      where: { id: existing.id },
      data: { accessTokenEnc, tokenType: 'pat' },
      select: connectionSelect,
    });
    setAuthCookie(reply, existing.userId);
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
  return reply.code(201).send({ connection: user.gitConnections[0] });
}

// Upserts one provider repo; returns true when an existing row was updated.
async function upsertRepository(
  connectionId: string,
  repo: NormalizedRepo,
): Promise<boolean> {
  const key = { connectionId, externalId: repo.externalId };
  const existing = await prisma.repository.findUnique({
    where: { connectionId_externalId: key },
    select: { id: true },
  });
  await prisma.repository.upsert({
    where: { connectionId_externalId: key },
    create: { connectionId, ...repo },
    update: {
      name: repo.name,
      fullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
    },
  });
  return existing !== null;
}

async function syncRepositories(
  connectionId: string,
  repos: NormalizedRepo[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const repo of repos) {
    if (await upsertRepository(connectionId, repo)) updated += 1;
    else created += 1;
  }
  return { created, updated };
}

// Returns the provider's repo list, or null after sending a 502.
async function listProviderRepos(
  connection: Parameters<typeof getProviderClient>[0],
  reply: FastifyReply,
): Promise<NormalizedRepo[] | null> {
  try {
    return await getProviderClient(connection).listRepos();
  } catch (err) {
    if (err instanceof ProviderError) {
      void reply.code(502).send({ error: `Failed to list repositories: ${err.message}` });
      return null;
    }
    throw err;
  }
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
    return reply.code(created ? 201 : 200).send({ connection });
  }
  return connectByPatIdentity(provider, username, baseUrl, accessTokenEnc, reply);
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

  const repos = await listProviderRepos(connection, reply);
  if (repos === null) return;
  const { created, updated } = await syncRepositories(connection.id, repos);
  return { synced: repos.length, created, updated };
}

const connectionsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/connections', { preHandler: requireAuth }, listConnections);
  app.post('/connections', { preHandler: optionalAuth }, connectWithPat);
  app.delete('/connections/:id', { preHandler: requireAuth }, deleteConnection);
  app.post('/connections/:id/sync', { preHandler: requireAuth }, syncConnectionRepos);
};

export default connectionsRoutes;
