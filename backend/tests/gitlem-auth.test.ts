import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for routes/gitlem-auth.ts: /register must validate the code
// FIRST and answer with one uniform error for a bad code and an existing
// email (no unauthenticated email enumeration), and /ensure must surface
// the foreign-account conflict as a 409 instead of linking the account.
// The gitlem-accounts lib, prisma, repo sync and the auth cookie are mocked.

const mocks = vi.hoisted(() => ({
  authenticateGitlem: vi.fn(),
  consumeRegistrationCode: vi.fn(),
  createGitlemAccount: vi.fn(),
  emailGeneratedCredentials: vi.fn(),
  ensureEmailChannel: vi.fn(),
  ensureGitlemAccountForUser: vi.fn(),
  findGitlemAccountForUser: vi.fn(),
  generateGitlemPassword: vi.fn(),
  issueRegistrationCode: vi.fn(),
  linkGitlemConnection: vi.fn(),
  gitlemUserFindUnique: vi.fn(),
  gitlemUserFindUniqueOrThrow: vi.fn(),
  userCreate: vi.fn(),
  settingFindFirst: vi.fn(),
  setAuthCookie: vi.fn(),
  syncConnection: vi.fn(),
}));

vi.mock('../src/lib/gitlem-accounts.js', () => ({
  authenticateGitlem: mocks.authenticateGitlem,
  consumeRegistrationCode: mocks.consumeRegistrationCode,
  createGitlemAccount: mocks.createGitlemAccount,
  emailGeneratedCredentials: mocks.emailGeneratedCredentials,
  ensureEmailChannel: mocks.ensureEmailChannel,
  ensureGitlemAccountForUser: mocks.ensureGitlemAccountForUser,
  findGitlemAccountForUser: mocks.findGitlemAccountForUser,
  generateGitlemPassword: mocks.generateGitlemPassword,
  issueRegistrationCode: mocks.issueRegistrationCode,
  linkGitlemConnection: mocks.linkGitlemConnection,
  GitlemAccountConflictError: class GitlemAccountConflictError extends Error {},
  GitlemEmailTakenError: class GitlemEmailTakenError extends Error {},
}));

vi.mock('../src/lib/notification-email.js', () => ({
  DeliveryError: class DeliveryError extends Error {},
  sendEmail: vi.fn(),
}));

vi.mock('../src/lib/repo-sync.js', () => ({
  syncConnectionByIdBestEffort: mocks.syncConnection,
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { create: mocks.userCreate },
    gitlemUser: {
      findUnique: mocks.gitlemUserFindUnique,
      findUniqueOrThrow: mocks.gitlemUserFindUniqueOrThrow,
    },
    notificationSetting: { findFirst: mocks.settingFindFirst },
  },
}));

vi.mock('../src/plugins/auth.js', () => ({
  setAuthCookie: mocks.setAuthCookie,
}));

import { gitlemAccountRoutes, gitlemAuthRoutes } from '../src/routes/gitlem-auth.js';

const REGISTER_ERROR = 'Invalid registration code or email already registered';

async function buildApp(authenticated = true) {
  const app = Fastify({ logger: false });
  app.decorateRequest('userId', undefined);
  app.addHook('onRequest', async (request) => {
    request.userId = authenticated ? 'user-1' : undefined;
  });
  await app.register(gitlemAuthRoutes, { prefix: '/api/gitlem/auth' });
  await app.register(gitlemAccountRoutes, { prefix: '/api/gitlem/account' });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateGitlemPassword.mockReturnValue('generated-pw');
  mocks.userCreate.mockResolvedValue({ id: 'user-9' });
  mocks.linkGitlemConnection.mockResolvedValue('conn-1');
});

describe('POST /api/gitlem/auth/register', () => {
  it('rejects a bad code with the uniform error and never probes the email', async () => {
    mocks.consumeRegistrationCode.mockResolvedValue(false);
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/gitlem/auth/register',
      payload: { email: 'a@b.co', code: '000000' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: REGISTER_ERROR });
    // No enumeration oracle: the email is never looked up before the code check.
    expect(mocks.gitlemUserFindUnique).not.toHaveBeenCalled();
    expect(mocks.createGitlemAccount).not.toHaveBeenCalled();
  });

  it('answers an existing email with the same uniform error (unique-race 409)', async () => {
    const { GitlemEmailTakenError } = await import('../src/lib/gitlem-accounts.js');
    mocks.consumeRegistrationCode.mockResolvedValue(true);
    mocks.createGitlemAccount.mockRejectedValue(new GitlemEmailTakenError('taken'));
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/gitlem/auth/register',
      payload: { email: 'taken@b.co', code: '123456' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: REGISTER_ERROR });
  });

  it('registers and emails the generated credentials when no password is chosen', async () => {
    mocks.consumeRegistrationCode.mockResolvedValue(true);
    mocks.createGitlemAccount.mockResolvedValue({
      gitlemUserId: 'gu-1',
      username: 'ann',
      apiToken: 'tok',
      password: 'generated-pw',
    });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/gitlem/auth/register',
      payload: { email: 'ann@b.co', code: '123456' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(mocks.createGitlemAccount).toHaveBeenCalledWith('ann@b.co', 'generated-pw');
    expect(mocks.emailGeneratedCredentials).toHaveBeenCalledWith('user-9', 'ann@b.co', 'generated-pw');
    expect(mocks.setAuthCookie).toHaveBeenCalledTimes(1);
  });

  it('does not email credentials when the user chose a password', async () => {
    mocks.consumeRegistrationCode.mockResolvedValue(true);
    mocks.createGitlemAccount.mockResolvedValue({
      gitlemUserId: 'gu-1',
      username: 'ann',
      apiToken: 'tok',
      password: 'chosen-password',
    });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/gitlem/auth/register',
      payload: { email: 'ann@b.co', code: '123456', password: 'chosen-password' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.createGitlemAccount).toHaveBeenCalledWith('ann@b.co', 'chosen-password');
    expect(mocks.emailGeneratedCredentials).not.toHaveBeenCalled();
  });
});

describe('POST /api/gitlem/account/ensure', () => {
  it('returns 409 when the resolved email belongs to a different gitlem account', async () => {
    const { GitlemAccountConflictError } = await import('../src/lib/gitlem-accounts.js');
    mocks.findGitlemAccountForUser.mockResolvedValue(null);
    mocks.settingFindFirst.mockResolvedValue({ target: 'victim@example.com' });
    mocks.ensureGitlemAccountForUser.mockRejectedValue(new GitlemAccountConflictError('conflict'));
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/gitlem/account/ensure' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/different gitlem account/);
  });

  it('returns the existing account without provisioning again', async () => {
    mocks.findGitlemAccountForUser.mockResolvedValue({ username: 'ann' });
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/gitlem/account/ensure' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ created: false, username: 'ann', emailed: false });
    expect(mocks.ensureGitlemAccountForUser).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const app = await buildApp(false);
    const response = await app.inject({ method: 'POST', url: '/api/gitlem/account/ensure' });
    expect(response.statusCode).toBe(401);
  });
});
