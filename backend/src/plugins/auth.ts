import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';

// Shared auth contract: JWT in an httpOnly cookie named `lemniscate_token`,
// signed with config.JWT_SECRET, payload { userId }.

export const AUTH_COOKIE = 'lemniscate_token';
export const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

interface AuthTokenPayload {
  userId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    // Set by `requireAuth`; undefined on unauthenticated requests.
    userId?: string;
  }
}

export function signAuthToken(userId: string): string {
  const payload: AuthTokenPayload = { userId };
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: AUTH_COOKIE_MAX_AGE_SECONDS,
  });
}

export function setAuthCookie(reply: FastifyReply, userId: string): void {
  reply.setCookie(AUTH_COOKIE, signAuthToken(userId), {
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

// Verifies the session JWT; returns the user id, or null when the token is
// missing a well-formed userId / invalid / expired. Single home for the JWT
// check shared by requireAuth and the connections route's optionalAuth.
export function verifyAuthToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    if (typeof decoded !== 'object' || decoded === null || typeof decoded.userId !== 'string') {
      return null;
    }
    return decoded.userId;
  } catch {
    return null;
  }
}

// Fastify preHandler: verifies the JWT cookie, loads the user, and decorates
// request.userId. Replies 401 and halts the request otherwise.
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = request.cookies[AUTH_COOKIE];
  if (!token) {
    await reply.code(401).send({ error: 'Authentication required' });
    return;
  }

  const userId = verifyAuthToken(token);
  if (!userId) {
    await reply.code(401).send({ error: 'Invalid or expired session' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    await reply.code(401).send({ error: 'User no longer exists' });
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
