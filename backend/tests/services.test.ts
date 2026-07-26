import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for /api/services: create/rename/env/deploy/stop/delete with
// prisma, docker, and the deploy queue mocked. The dynamic Traefik endpoint
// is covered by token checks + config builder tests.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  serviceFindMany: vi.fn(),
  serviceFindFirst: vi.fn(),
  serviceCreate: vi.fn(),
  serviceUpdate: vi.fn(),
  serviceDelete: vi.fn(),
  repositoryFindFirst: vi.fn(),
  deploymentFindMany: vi.fn(),
  queueDeployment: vi.fn(),
  stopRemoveContainer: vi.fn(),
  tailContainerLogs: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    service: {
      findMany: mocks.serviceFindMany,
      findFirst: mocks.serviceFindFirst,
      create: mocks.serviceCreate,
      update: mocks.serviceUpdate,
      delete: mocks.serviceDelete,
    },
    repository: { findFirst: mocks.repositoryFindFirst },
    deployment: { findMany: mocks.deploymentFindMany },
  },
}));
vi.mock('../src/lib/deploy/deploy-service.js', () => ({
  queueDeployment: mocks.queueDeployment,
}));
vi.mock('../src/lib/deploy/docker-apps.js', () => ({
  stopRemoveContainer: mocks.stopRemoveContainer,
  tailContainerLogs: mocks.tailContainerLogs,
}));

import servicesRoutes from '../src/routes/services.js';
import { signAuthToken } from '../src/plugins/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(servicesRoutes, { prefix: '/api' });
  return app;
}

const AUTH = { cookies: { lemniscate_token: signAuthToken('user-1', 0) } };

const REPO = {
  id: 'repo-1',
  name: 'My App',
  fullName: 'grig-teo/my-app',
  defaultBranch: 'main',
  connection: { username: 'grig-teo', provider: 'github' },
  service: null,
};

const SERVICE = {
  id: 'svc-1',
  repositoryId: 'repo-1',
  name: 'my-app',
  port: 80,
  envEnc: null,
  autoDeploy: true,
  status: 'stopped',
  activeContainer: null,
  repository: REPO,
  deployments: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.repositoryFindFirst.mockResolvedValue(REPO);
  mocks.serviceFindFirst.mockResolvedValue(null); // slug check: free
  mocks.serviceCreate.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'svc-1',
    ...data,
  }));
});

describe('POST /api/services', () => {
  it('requires auth', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { repositoryId: 'repo-1' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('creates a service with the slugified repo name and its URL', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { repositoryId: 'repo-1' },
      ...AUTH,
    });
    expect(response.statusCode).toBe(201);
    expect(mocks.serviceCreate).toHaveBeenCalledWith({
      data: { repositoryId: 'repo-1', name: 'my-app' },
    });
    expect(response.json().service.url).toBe('https://apps.grig-teo.space/grig-teo/my-app');
  });

  it('409s when the repository already has a service', async () => {
    mocks.repositoryFindFirst.mockResolvedValue({ ...REPO, service: { id: 'svc-1' } });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { repositoryId: 'repo-1' },
      ...AUTH,
    });
    expect(response.statusCode).toBe(409);
  });

  it('409s when the slug is taken by another service of the same owner', async () => {
    mocks.serviceFindFirst.mockResolvedValue({ id: 'svc-other' });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { repositoryId: 'repo-1' },
      ...AUTH,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('/grig-teo/my-app');
  });
});

describe('PUT /api/services/:id/env', () => {
  it('stores encrypted env and returns only keys', async () => {
    mocks.serviceFindFirst.mockResolvedValue(SERVICE);
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/services/svc-1/env',
      payload: { set: { API_KEY: 'secret-value', DEBUG: '1' }, remove: [] },
      ...AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().keys.sort()).toEqual(['API_KEY', 'DEBUG']);
    const update = mocks.serviceUpdate.mock.calls[0]![0];
    expect(update.data.envEnc).toEqual(expect.any(String));
    expect(update.data.envEnc).not.toContain('secret-value');
  });

  it('rejects invalid env var names', async () => {
    mocks.serviceFindFirst.mockResolvedValue(SERVICE);
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/services/svc-1/env',
      payload: { set: { '1BAD': 'x' }, remove: [] },
      ...AUTH,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/services/:id/deploy and stop', () => {
  it('queues a deployment and marks the service deploying', async () => {
    mocks.serviceFindFirst.mockResolvedValue(SERVICE);
    mocks.queueDeployment.mockResolvedValue({ id: 'dep-1' });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/services/svc-1/deploy',
      ...AUTH,
    });
    expect(response.statusCode).toBe(202);
    expect(mocks.queueDeployment).toHaveBeenCalledWith('svc-1', null);
    expect(mocks.serviceUpdate).toHaveBeenCalledWith({
      where: { id: 'svc-1' },
      data: { status: 'deploying' },
    });
  });

  it('stop removes the active container and clears it', async () => {
    mocks.serviceFindFirst.mockResolvedValue({ ...SERVICE, activeContainer: 'app-svc-1-deadbeef' });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/services/svc-1/stop',
      ...AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.stopRemoveContainer).toHaveBeenCalledWith('app-svc-1-deadbeef');
    expect(mocks.serviceUpdate).toHaveBeenCalledWith({
      where: { id: 'svc-1' },
      data: { activeContainer: null, status: 'stopped' },
    });
  });
});
