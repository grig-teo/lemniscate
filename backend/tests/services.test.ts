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
  vpsTargetFindFirst: vi.fn(),
  deploymentFindMany: vi.fn(),
  queueDeployment: vi.fn(),
  stopRemoveContainer: vi.fn(),
  stopVpsContainer: vi.fn(),
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
    vpsTarget: { findFirst: mocks.vpsTargetFindFirst },
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
vi.mock('../src/lib/deploy/vps-deploy.js', () => ({
  stopVpsContainer: mocks.stopVpsContainer,
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
  hostPort: null,
  envEnc: null,
  autoDeploy: true,
  status: 'stopped',
  activeContainer: null,
  deployTarget: 'lemniscate' as const,
  vpsTargetId: null,
  vpsTarget: null,
  repository: REPO,
  deployments: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.repositoryFindFirst.mockResolvedValue(REPO);
  mocks.vpsTargetFindFirst.mockResolvedValue(null);
  mocks.serviceFindFirst.mockResolvedValue(null); // slug check: free
  mocks.serviceFindMany.mockResolvedValue([]); // hostPort allocation: none used
  mocks.serviceCreate.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'svc-1',
    ...data,
  }));
  mocks.serviceUpdate.mockResolvedValue(SERVICE);
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
    expect(mocks.serviceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { repositoryId: 'repo-1', name: 'my-app', deployTarget: 'lemniscate', vpsTargetId: null },
      }),
    );
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

describe('deployTarget validation on POST /api/services', () => {
  it('400s when deployTarget is vps but no vpsTargetId is provided', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { repositoryId: 'repo-1', deployTarget: 'vps' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('vpsTargetId');
    expect(mocks.serviceCreate).not.toHaveBeenCalled();
  });

  it('404s when the vpsTargetId belongs to another user', async () => {
    mocks.vpsTargetFindFirst.mockResolvedValue(null); // unowned
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { repositoryId: 'repo-1', deployTarget: 'vps', vpsTargetId: 'tgt-other' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('VPS target not found');
    expect(mocks.serviceCreate).not.toHaveBeenCalled();
  });

  it('persists deployTarget, vpsTargetId, and an allocated hostPort when the target is owned', async () => {
    mocks.vpsTargetFindFirst.mockResolvedValue({ id: 'tgt-1' }); // owned
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { repositoryId: 'repo-1', deployTarget: 'vps', vpsTargetId: 'tgt-1' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(201);
    const createData = mocks.serviceCreate.mock.calls[0]![0].data;
    expect(createData.deployTarget).toBe('vps');
    expect(createData.vpsTargetId).toBe('tgt-1');
    expect(createData.hostPort).toEqual(expect.any(Number));
  });

  it('allocates the next free hostPort per VPS target (no collision)', async () => {
    mocks.vpsTargetFindFirst.mockResolvedValue({ id: 'tgt-1' });
    // Simulate an existing VPS service already using port 30000.
    mocks.serviceFindMany.mockResolvedValue([{ hostPort: 30000 }]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: { repositoryId: 'repo-1', deployTarget: 'vps', vpsTargetId: 'tgt-1' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(201);
    expect(mocks.serviceCreate.mock.calls[0]![0].data.hostPort).toBe(30001);
  });
});

describe('GET /api/services URL computation', () => {
  it('returns a VPS-target URL (http://host:hostPort) for vps services, not the platform URL', async () => {
    const vpsService = {
      ...SERVICE,
      deployTarget: 'vps' as const,
      vpsTargetId: 'tgt-1',
      hostPort: 30042,
      vpsTarget: { id: 'tgt-1', name: 'prod-box', host: 'vps.example.com', port: 22 },
      repository: REPO,
      deployments: [],
    };
    mocks.serviceFindMany.mockResolvedValue([vpsService]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/services', ...AUTH });
    expect(res.statusCode).toBe(200);
    const svc = res.json().services[0];
    expect(svc.url).toBe('http://vps.example.com:30042');
    expect(svc.url).not.toContain('apps.grig-teo.space');
  });

  it('returns the platform URL for lemniscate services', async () => {
    mocks.serviceFindMany.mockResolvedValue([{ ...SERVICE, deployments: [] }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/services', ...AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().services[0].url).toBe('https://apps.grig-teo.space/grig-teo/my-app');
  });
});

describe('deployTarget validation on PATCH /api/services/:id', () => {
  it('flips lemniscate to vps and sets the vpsTargetId', async () => {
    mocks.serviceFindFirst.mockResolvedValue(SERVICE);
    mocks.vpsTargetFindFirst.mockResolvedValue({ id: 'tgt-1' });
    const updated = { ...SERVICE, deployTarget: 'vps' as const, vpsTargetId: 'tgt-1' };
    mocks.serviceUpdate.mockResolvedValue(updated);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/services/svc-1',
      payload: { deployTarget: 'vps', vpsTargetId: 'tgt-1' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = mocks.serviceUpdate.mock.calls[0]![0].data;
    expect(data.deployTarget).toBe('vps');
    expect(data.vpsTargetId).toBe('tgt-1');
  });

  it('allocates a hostPort when flipping to vps', async () => {
    mocks.serviceFindFirst.mockResolvedValue(SERVICE);
    mocks.vpsTargetFindFirst.mockResolvedValue({ id: 'tgt-1' });
    mocks.serviceUpdate.mockResolvedValue({ ...SERVICE, deployTarget: 'vps', vpsTargetId: 'tgt-1' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/services/svc-1',
      payload: { deployTarget: 'vps', vpsTargetId: 'tgt-1' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.serviceUpdate.mock.calls[0]![0].data.hostPort).toBe(30000);
  });

  it('preserves an existing hostPort when re-deploying to the same vps target', async () => {
    const vpsService = { ...SERVICE, deployTarget: 'vps' as const, vpsTargetId: 'tgt-1', hostPort: 30042 };
    mocks.serviceFindFirst.mockResolvedValue(vpsService);
    mocks.vpsTargetFindFirst.mockResolvedValue({ id: 'tgt-1' });
    mocks.serviceUpdate.mockResolvedValue(vpsService);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/services/svc-1',
      payload: { deployTarget: 'vps', vpsTargetId: 'tgt-1' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(200);
    // Should NOT change the hostPort — it stays at 30042.
    expect(mocks.serviceUpdate.mock.calls[0]![0].data.hostPort).toBe(30042);
  });

  it('flips vps back to lemniscate and clears vpsTargetId', async () => {
    const vpsService = { ...SERVICE, deployTarget: 'vps' as const, vpsTargetId: 'tgt-1' };
    mocks.serviceFindFirst.mockResolvedValue(vpsService);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/services/svc-1',
      payload: { deployTarget: 'lemniscate' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = mocks.serviceUpdate.mock.calls[0]![0].data;
    expect(data.deployTarget).toBe('lemniscate');
    expect(data.vpsTargetId).toBeNull();
  });
});
