import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';

// Shared auth contract: JWT in an httpOnly cookie named `lemniscate_token`,
// signed with config.JWT_SECRET (HS256 only), payload { userId, sv } where
// `sv` is the user's sessionVersion at issue time — bumping it (logout,
// last git connection removed) revokes every previously issued token.

export const AUTH_COOKIE = 'lemniscate_token';
export const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface AuthTokenPayload {
  userId: string;
  sv: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    // Set by `requireAuth`; undefined on unauthenticated requests.
    userId?: string;
  }
}

export function signAuthToken(userId: string, sessionVersion: number): string {
  const payload: AuthTokenPayload = { userId, sv: sessionVersion };
  return jwt.sign(payload, config.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: AUTH_COOKIE_MAX_AGE_SECONDS,
  });
}

export async function setAuthCookie(reply: FastifyReply, userId: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { sessionVersion: true },
  });
  reply.setCookie(AUTH_COOKIE, signAuthToken(userId, user.sessionVersion), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(AUTH_COOKIE, { path: '/' });
}

// Verifies the session JWT; returns the payload, or null when the token is
// invalid / expired / not HS256 / missing the sv claim (pre-migration
// tokens, which forces one re-login). Single home for the JWT check shared
// by requireAuth, the connections route's optionalAuth and the OAuth
// session lookup.
export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded !== 'object' || decoded === null) {
      return null;
    }
    if (typeof decoded.userId !== 'string' || typeof decoded.sv !== 'number') {
      return null;
    }
    return { userId: decoded.userId, sv: decoded.sv };
  } catch {
    return null;
  }
}

// Revokes every session of the user: tokens issued before the bump carry an
// older `sv` and fail the requireAuth check below.
export async function bumpSessionVersion(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
  });
}

// Fastify preHandler: verifies the JWT cookie, loads the user, rejects when
// the token's sv no longer matches, and decorates request.userId. Replies
// 401 and halts the request otherwise.
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = request.cookies[AUTH_COOKIE];
  if (!token) {
    await reply.code(401).send({ error: 'Authentication required' });
    return;
  }

  const payload = verifyAuthToken(token);
  if (!payload) {
    await reply.code(401).send({ error: 'Invalid or expired session' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, sessionVersion: true },
  });
  if (!user) {
    await reply.code(401).send({ error: 'User no longer exists' });
    return;
  }
  if (user.sessionVersion !== payload.sv) {
    await reply.code(401).send({ error: 'Session has been revoked' });
    return;
  }

  request.userId = user.id;
}

// For handlers that run after `requireAuth`: returns the authenticated
// user id, throwing if the preHandler was not applied.
export function authenticatedUserId(request: FastifyRequest): string {
  if (!request.userId) {
    throw new Error('authenticatedUserId called without requireAuth preHandler');
  }
  return request.userId;
}
