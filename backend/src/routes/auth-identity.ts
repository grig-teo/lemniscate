import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { syncConnectionByIdBestEffort } from '../lib/repo-sync.js';
import { AUTH_COOKIE, setAuthCookie, verifyAuthToken } from '../plugins/auth.js';
import { oauthConnectionFields, type OAuthProviderName, type OAuthTokens } from './auth-oauth.js';

// OAuth identity resolution: decides which user an OAuth connection belongs
// to (the logged-in session user when there is one, otherwise the
// no-session upsert path) and finishes the login round-trip.

// Finds the user behind an OAuth connection, or creates a new user plus
// connection. The stored tokens are always refreshed.
async function upsertOAuthConnection(
  provider: OAuthProviderName,
  username: string,
  tokens: OAuthTokens,
): Promise<{ userId: string; connectionId: string }> {
  const existing = await prisma.gitConnection.findFirst({
    where: { provider, username },
  });
  if (existing) {
    // Reconnecting always reactivates a soft-disconnected row — same user,
    // same repositories, fresh tokens.
    const connection = await prisma.gitConnection.update({
      where: { id: existing.id },
      data: oauthConnectionFields(tokens),
    });
    return { userId: connection.userId, connectionId: connection.id };
  }
  const user = await prisma.user.create({
    data: {
      gitConnections: {
        create: { provider, username, ...oauthConnectionFields(tokens) },
      },
    },
    include: { gitConnections: { select: { id: true } } },
  });
  return { userId: user.id, connectionId: user.gitConnections[0]?.id as string };
}

// Returns the logged-in user id from the session cookie, or null when the
// request carries no valid session (missing/invalid/expired/revoked token,
// or the user was deleted). Used to attach new OAuth connections to the
// current user instead of creating a new identity.
async function sessionUserId(request: FastifyRequest): Promise<string | null> {
  const token = request.cookies[AUTH_COOKIE];
  if (!token) return null;
  const payload = verifyAuthToken(token);
  if (!payload) return null;
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || user.sessionVersion !== payload.sv) return null;
  return user.id;
}

// Attaches an OAuth connection to the given (logged-in) user. Reconnecting a
// host refreshes the stored tokens and re-points the connection at this user —
// which also merges identities that were split by earlier logins.
async function attachOAuthConnection(
  userId: string,
  provider: OAuthProviderName,
  username: string,
  tokens: OAuthTokens,
): Promise<string> {
  const existing = await prisma.gitConnection.findFirst({
    where: { provider, username },
  });
  if (existing) {
    const connection = await prisma.gitConnection.update({
      where: { id: existing.id },
      data: { ...oauthConnectionFields(tokens), userId },
    });
    return connection.id;
  }
  const connection = await prisma.gitConnection.create({
    data: { provider, username, ...oauthConnectionFields(tokens), userId },
  });
  return connection.id;
}

// Decides whose identity the OAuth connection belongs to: the logged-in
// session user when there is one, otherwise the no-session upsert path.
export async function resolveOAuthIdentity(
  provider: OAuthProviderName,
  username: string,
  tokens: OAuthTokens,
  request: FastifyRequest,
): Promise<{ userId: string; connectionId: string }> {
  const loggedInUserId = await sessionUserId(request);
  if (!loggedInUserId) {
    return upsertOAuthConnection(provider, username, tokens);
  }
  const connectionId = await attachOAuthConnection(loggedInUserId, provider, username, tokens);
  return { userId: loggedInUserId, connectionId };
}

// Sets the session cookie, kicks off a best-effort repo sync, and redirects
// to the dashboard after a successful OAuth round-trip.
export async function finishOAuthLogin(
  userId: string,
  connectionId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  await setAuthCookie(reply, userId);
  // Pull repos right away so the landing/dashboard are populated on first
  // visit; a failed sync must not break the login.
  await syncConnectionByIdBestEffort(connectionId, request.log);
  return reply.redirect(`${config.FRONTEND_URL.replace(/\/+$/, '')}/dashboard`, 302);
}
