import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for the OAuth hardening:
// - state/PKCE helpers (HMAC-signed state, S256 challenge);
// - PKCE is added to the GitHub/GitLab authorize URLs and token exchanges;
// - provider error details are logged, never echoed in the 502 body;
// - logout revokes the session (sessionVersion bump).

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  connFindFirst: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate },
    gitConnection: { findFirst: mocks.connFindFirst },
  },
}));
vi.mock('../src/lib/repo-sync.js', () => ({
  syncConnectionByIdBestEffort: vi.fn(),
}));

import authRoutes, {
  generatePkce,
  signState,
  tokenRequestBody,
  buildAuthorizeUrl,
  oauthProviders,
  verifyState,
} from '../src/routes/auth.js';
import { signAuthToken } from '../src/plugins/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(authRoutes, { prefix: '/api' });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('state helpers', () => {
  it('round-trips a signed state', () => {
    const state = signState('nonce-123');
    expect(verifyState(state)).toBe(true);
  });

  it('rejects a tampered state', () => {
    const state = signState('nonce-123');
    expect(verifyState(`evil${state.slice(4)}`)).toBe(false);
    expect(verifyState('no-dot-here')).toBe(false);
  });
});

describe('generatePkce', () => {
  it('derives the S256 challenge from the verifier', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(challenge).not.toBe(verifier);
  });
});

describe('authorize URL + token body', () => {
  it('adds the S256 challenge to the authorize URL when given', () => {
    const url = new URL(buildAuthorizeUrl('github', oauthProviders().github, 'state', 'challenge'));
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('omits PKCE params without a challenge', () => {
    const url = new URL(buildAuthorizeUrl('gitee', oauthProviders().gitee, 'state'));
    expect(url.searchParams.get('code_challenge')).toBeNull();
  });

  it('sends the verifier on the token exchange', () => {
    const body = tokenRequestBody('gitlab', oauthProviders().gitlab, 'code', 'verifier');
    expect(body.code_verifier).toBe('verifier');
  });
});

describe('POST /api/auth/logout', () => {
  it('bumps sessionVersion so previously issued tokens die', async () => {
    mocks.userUpdate.mockResolvedValue({});
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { lemniscate_token: signAuthToken('user-1', 0) },
    });
    expect(response.statusCode).toBe(204);
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { sessionVersion: { increment: 1 } },
    });
    expect(response.cookies[0]?.name).toBe('lemniscate_token');
    expect(response.cookies[0]?.value).toBe('');
  });

  it('stays a plain 204 without a session cookie', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(response.statusCode).toBe(204);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

describe('GET /api/auth/:provider/callback', () => {
  it('returns a generic 502 without echoing the provider error_description', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired. SECRET-DETAIL',
        }),
      })),
    );
    const state = signState('nonce-1');
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
      cookies: { lemniscate_oauth_state: state },
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('SECRET-DETAIL');
    expect(response.body).not.toContain('bad_verification_code');
    expect(response.json().error).toBe('OAuth login via github failed');
  });
});
