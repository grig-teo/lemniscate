import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for POST /api/repositories/:id/deploy-android: ownership and
// platform gates, and the build_android command it creates for the builder.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  repositoryFindFirst: vi.fn(),
  deviceFindMany: vi.fn(),
  commandCreate: vi.fn(),
  commandUpdate: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    repository: { findFirst: mocks.repositoryFindFirst },
    device: { findMany: mocks.deviceFindMany },
    deviceCommand: { create: mocks.commandCreate, update: mocks.commandUpdate },
  },
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
const BODY = { buildDeviceId: 'dev-builder', installDeviceId: 'dev-phone' };

const ANDROID_REPO = {
  id: 'repo-1',
  name: 'shopping-app',
  cloneUrl: 'https://github.com/a/shopping-app',
  defaultBranch: 'main',
  platform: 'android',
};

function deploy(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({
    method: 'POST',
    url: '/api/repositories/repo-1/deploy-android',
    ...AUTH,
    payload: BODY,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.repositoryFindFirst.mockResolvedValue(ANDROID_REPO);
  mocks.deviceFindMany.mockResolvedValue([{ id: 'dev-builder' }, { id: 'dev-phone' }]);
  mocks.commandCreate.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'cmd-1',
    status: 'queued',
    ...data,
  }));
});

describe('POST /api/repositories/:id/deploy-android', () => {
  it('requires auth', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/repositories/repo-1/deploy-android',
      payload: BODY,
    });
    expect(response.statusCode).toBe(401);
  });

  it('404s a foreign repository and 400s a non-android one', async () => {
    mocks.repositoryFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    expect((await deploy(app)).statusCode).toBe(404);
    mocks.repositoryFindFirst.mockResolvedValue({ ...ANDROID_REPO, platform: 'web' });
    const response = await deploy(app);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('android');
    expect(mocks.commandCreate).not.toHaveBeenCalled();
  });

  it('404s when a device is missing or foreign', async () => {
    mocks.deviceFindMany.mockResolvedValue([{ id: 'dev-builder' }]);
    const app = await buildApp();
    expect((await deploy(app)).statusCode).toBe(404);
    expect(mocks.commandCreate).not.toHaveBeenCalled();
  });

  it('creates a build_android command carrying repo + install target', async () => {
    const app = await buildApp();
    const response = await deploy(app);
    expect(response.statusCode).toBe(201);
    expect(mocks.deviceFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', id: { in: ['dev-builder', 'dev-phone'] } },
      select: { id: true },
    });
    expect(mocks.commandCreate).toHaveBeenCalledWith({
      data: {
        deviceId: 'dev-builder',
        type: 'build_android',
        payload: {
          repoUrl: 'https://github.com/a/shopping-app',
          branch: 'main',
          installDeviceId: 'dev-phone',
          appName: 'shopping-app',
        },
      },
    });
    expect(response.json().command.status).toBe('queued');
  });
});
