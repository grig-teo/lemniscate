import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for POST /api/repositories/:id/detect-platform: owner-only,
// fetches the provider root listing, stores the detected platform on the
// Repository row and returns it. The classifier itself is covered in
// repo-platform.test.ts.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  repoFindFirst: vi.fn(),
  repoUpdate: vi.fn(),
  listRootEntries: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    repository: { findFirst: mocks.repoFindFirst, update: mocks.repoUpdate },
  },
}));
vi.mock('../src/lib/git-providers.js', () => ({
  GIT_HTTP_AUTH_USERNAME: 'lemniscate',
  tokenlessCloneUrl: (url: string) => url,
  getProviderClient: () => ({ listRootEntries: mocks.listRootEntries }),
}));

import repositoriesRoutes from '../src/routes/repositories.js';
import { signAuthToken } from '../src/plugins/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(repositoriesRoutes, { prefix: '/api' });
  return app;
}

const AUTH = { cookies: { lemniscate_token: signAuthToken('user-1', 0) } };

const OWNED_REPO = {
  id: 'repo-1',
  fullName: 'ivan/app',
  connection: { id: 'conn-1', userId: 'user-1', provider: 'github' },
};

function detect(app: Awaited<ReturnType<typeof buildApp>>, id = 'repo-1') {
  return app.inject({ method: 'POST', url: `/api/repositories/${id}/detect-platform`, ...AUTH });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.repoFindFirst.mockResolvedValue(OWNED_REPO);
  mocks.listRootEntries.mockResolvedValue(['settings.gradle', 'app']);
  mocks.repoUpdate.mockResolvedValue({});
});

describe('POST /api/repositories/:id/detect-platform', () => {
  it('requires auth', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/repositories/repo-1/detect-platform',
    });
    expect(response.statusCode).toBe(401);
  });

  it('404s a repository owned by someone else', async () => {
    mocks.repoFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    expect((await detect(app)).statusCode).toBe(404);
    expect(mocks.listRootEntries).not.toHaveBeenCalled();
  });

  it('detects, stores and returns the platform', async () => {
    const app = await buildApp();
    const response = await detect(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ platform: 'android' });
    expect(mocks.listRootEntries).toHaveBeenCalledWith('ivan/app');
    expect(mocks.repoUpdate).toHaveBeenCalledWith({
      where: { id: 'repo-1' },
      data: { platform: 'android' },
    });
  });

  it('stores unknown for an unrecognized listing', async () => {
    mocks.listRootEntries.mockResolvedValue(['README.md']);
    const app = await buildApp();
    expect((await detect(app)).json()).toEqual({ platform: 'unknown' });
  });

  it('502s when the provider listing fails and stores nothing', async () => {
    mocks.listRootEntries.mockRejectedValue(new Error('provider down'));
    const app = await buildApp();
    expect((await detect(app)).statusCode).toBe(502);
    expect(mocks.repoUpdate).not.toHaveBeenCalled();
  });
});
