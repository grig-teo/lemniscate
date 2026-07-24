import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for the connections route hardening:
// - gitverse baseUrl must be https and publicly routable (SSRF guard);
// - the unauthenticated PAT first-connect flow stays intact (and validated);
// - a PAT identity already owned by another user conflicts (409), while a
//   same-user unique race degrades to a token update;
// - deleting the LAST git connection revokes the session (sv bump).

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  connFindFirst: vi.fn(),
  connCreate: vi.fn(),
  connUpdate: vi.fn(),
  connDeleteMany: vi.fn(),
  connCount: vi.fn(),
  fetchProviderProfile: vi.fn(),
  syncBestEffort: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate },
    gitConnection: {
      findFirst: mocks.connFindFirst,
      create: mocks.connCreate,
      update: mocks.connUpdate,
      deleteMany: mocks.connDeleteMany,
      count: mocks.connCount,
    },
    repository: { findFirst: vi.fn(), updateMany: vi.fn() },
    llmConfig: { findFirst: vi.fn() },
    task: { create: vi.fn() },
    skill: { findMany: vi.fn() },
  },
}));
vi.mock('../src/lib/git-providers.js', () => ({
  fetchProviderProfile: mocks.fetchProviderProfile,
  getProviderClient: vi.fn(),
  ProviderError: class ProviderError extends Error {},
}));
vi.mock('../src/lib/proposal-scheduler.js', () => ({ enqueueRunTask: vi.fn() }));
vi.mock('../src/lib/repo-init.js', () => ({
  buildRepoInitFiles: vi.fn(),
  initializeRepoFiles: vi.fn(),
}));
vi.mock('../src/lib/repo-sync.js', () => ({
  syncConnectionByIdBestEffort: mocks.syncBestEffort,
  syncConnectionRepositories: vi.fn(),
}));
vi.mock('../src/lib/task-skills.js', () => ({
  findUnknownMcpServerSlugs: vi.fn(),
  findUnknownSkillSlugs: vi.fn(),
  isAgentsMdSkill: vi.fn(),
  loadAgentsMdTemplate: vi.fn(),
  resolveAgentsMdFileContents: vi.fn(),
  resolveMcpServerConfigs: vi.fn(),
}));

import connectionsRoutes from '../src/routes/connections.js';
import { signAuthToken } from '../src/plugins/auth.js';

const PUBLIC_URL = 'https://203.0.113.10'; // documentation range, no DNS needed

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.0.0',
  });
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(connectionsRoutes, { prefix: '/api' });
  return app;
}

function authCookie(userId = 'user-1', sv = 0): Record<string, string> {
  mocks.userFindUnique.mockResolvedValue({ id: userId, sessionVersion: sv });
  return { lemniscate_token: signAuthToken(userId, sv) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchProviderProfile.mockResolvedValue({ username: 'octo' });
  mocks.syncBestEffort.mockResolvedValue(undefined);
});

describe('POST /api/connections gitverse baseUrl validation', () => {
  it('rejects a non-https baseUrl with 400', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { provider: 'gitverse', token: 'pat', baseUrl: 'http://203.0.113.10' },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.fetchProviderProfile).not.toHaveBeenCalled();
  });

  it('rejects a baseUrl resolving to a private address with 400', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { provider: 'gitverse', token: 'pat', baseUrl: 'https://192.168.1.1' },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.fetchProviderProfile).not.toHaveBeenCalled();
  });

  it('still runs the unauthenticated PAT first-connect flow for a public https URL', async () => {
    mocks.connFindFirst.mockResolvedValue(null); // unknown identity → 401, not 400
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { provider: 'gitverse', token: 'pat', baseUrl: PUBLIC_URL },
    });
    expect(mocks.fetchProviderProfile).toHaveBeenCalledWith('gitverse', 'pat', PUBLIC_URL);
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('No account matches this token');
  });
});

describe('POST /api/connections PAT identity uniqueness', () => {
  it('degrades a same-user unique race to a token update', async () => {
    const view = { id: 'c1', provider: 'github', baseUrl: null, username: 'octo' };
    mocks.connFindFirst
      .mockResolvedValueOnce(null) // no row scoped to this user
      .mockResolvedValueOnce({ id: 'c1', userId: 'user-1' }); // race winner lookup
    mocks.connCreate.mockRejectedValue(p2002());
    mocks.connUpdate.mockResolvedValue(view);
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      cookies: authCookie(),
      payload: { provider: 'github', token: 'pat' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ connection: view });
    expect(mocks.connUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' } }),
    );
  });

  it('409s when the PAT identity belongs to another user', async () => {
    mocks.connFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c1', userId: 'user-2' });
    mocks.connCreate.mockRejectedValue(p2002());
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      cookies: authCookie(),
      payload: { provider: 'github', token: 'pat' },
    });
    expect(response.statusCode).toBe(409);
    expect(mocks.connUpdate).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/connections/:id session revocation', () => {
  it('bumps sessionVersion when the deleted connection was the last one', async () => {
    mocks.connDeleteMany.mockResolvedValue({ count: 1 });
    mocks.connCount.mockResolvedValue(0);
    const app = await buildApp();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/connections/c1',
      cookies: authCookie(),
    });
    expect(response.statusCode).toBe(204);
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { sessionVersion: { increment: 1 } },
    });
  });

  it('keeps the session when other connections remain', async () => {
    mocks.connDeleteMany.mockResolvedValue({ count: 1 });
    mocks.connCount.mockResolvedValue(2);
    const app = await buildApp();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/connections/c1',
      cookies: authCookie(),
    });
    expect(response.statusCode).toBe(204);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});
