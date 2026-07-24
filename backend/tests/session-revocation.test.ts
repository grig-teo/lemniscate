import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';

// Locking tests for JWT hardening + session revocation:
// - tokens are signed/verified with HS256 only;
// - every session token carries the user's sessionVersion (`sv` claim);
// - tokens without `sv` (pre-migration) are rejected → one re-login;
// - bumping sessionVersion (logout / last connection removed) 401s old tokens.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate } },
}));

import {
  AUTH_COOKIE,
  bumpSessionVersion,
  requireAuth,
  signAuthToken,
  verifyAuthToken,
} from '../src/plugins/auth.js';

function signRaw(payload: object, algorithm: jwt.Algorithm = 'HS256'): string {
  return jwt.sign(payload, config.JWT_SECRET, { algorithm });
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.get('/protected', { preHandler: requireAuth }, async (request) => ({ userId: request.userId }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('signAuthToken / verifyAuthToken', () => {
  it('embeds the session version and round-trips it', () => {
    const token = signAuthToken('user-1', 3);
    expect(verifyAuthToken(token)).toEqual({ userId: 'user-1', sv: 3 });
  });

  it('rejects tokens without an sv claim (pre-migration sessions)', () => {
    expect(verifyAuthToken(signRaw({ userId: 'user-1' }))).toBeNull();
  });

  it('rejects tokens signed with a non-HS256 algorithm', () => {
    expect(verifyAuthToken(signRaw({ userId: 'user-1', sv: 0 }, 'HS384'))).toBeNull();
    expect(verifyAuthToken(signRaw({ userId: 'user-1', sv: 0 }, 'HS512'))).toBeNull();
  });

  it('rejects tokens signed with a different secret', () => {
    const token = jwt.sign({ userId: 'user-1', sv: 0 }, 'other-secret-other-secret-other!');
    expect(verifyAuthToken(token)).toBeNull();
  });
});

describe('requireAuth session-version check', () => {
  it('accepts a token whose sv matches the stored sessionVersion', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 2 });
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [AUTH_COOKIE]: signAuthToken('user-1', 2) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: 'user-1' });
  });

  it('rejects a token issued before the session was revoked (logout bump)', async () => {
    // Token issued at sv 0; user then logged out → sessionVersion is now 1.
    mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 1 });
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [AUTH_COOKIE]: signAuthToken('user-1', 0) },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a token without sv even when the user exists', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [AUTH_COOKIE]: signRaw({ userId: 'user-1' }) },
    });
    expect(response.statusCode).toBe(401);
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
  });
});

describe('bumpSessionVersion', () => {
  it('increments the stored sessionVersion', async () => {
    mocks.userUpdate.mockResolvedValue({});
    await bumpSessionVersion('user-1');
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { sessionVersion: { increment: 1 } },
    });
  });
});
