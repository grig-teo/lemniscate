import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for /api/vps-targets: CRUD + connectivity-test endpoints.
// prisma and the SSH probe are mocked; auth follows the services.test.ts
// pattern (signed cookie for user-1). The plugin is registered with the
// production prefix so the routes resolve to /api/vps-targets, not
// /api/vps-targets/vps-targets (the bug that motivated this test file).

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  vpsTargetFindMany: vi.fn(),
  vpsTargetFindFirst: vi.fn(),
  vpsTargetCreate: vi.fn(),
  vpsTargetUpdate: vi.fn(),
  vpsTargetDelete: vi.fn(),
  serviceUpdateMany: vi.fn(),
  testVpsConnection: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    vpsTarget: {
      findMany: mocks.vpsTargetFindMany,
      findFirst: mocks.vpsTargetFindFirst,
      create: mocks.vpsTargetCreate,
      update: mocks.vpsTargetUpdate,
      delete: mocks.vpsTargetDelete,
    },
    service: { updateMany: mocks.serviceUpdateMany },
  },
}));
vi.mock('../src/lib/deploy/vps.js', () => ({
  testVpsConnection: mocks.testVpsConnection,
}));

import vpsTargetRoutes from '../src/routes/vps-targets.js';
import { signAuthToken } from '../src/plugins/auth.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  // Matches the production mount in app.ts (prefix: '/api'), proving the
  // handler paths /vps-targets, /vps-targets/:id, etc. resolve correctly.
  await app.register(vpsTargetRoutes, { prefix: '/api' });
  return app;
}

const AUTH = { cookies: { lemniscate_token: signAuthToken('user-1', 0) } };

const PASSWORD_BODY = {
  name: 'prod-box',
  host: '203.0.113.10',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  secret: 's3cret-pw',
};

const KEY_BODY = {
  name: 'staging',
  host: 'staging.example.com',
  port: 2222,
  username: 'root',
  authMethod: 'key',
  secret: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----',
};

const TARGET_ROW = {
  id: 'tgt-1',
  userId: 'user-1',
  name: 'prod-box',
  host: '203.0.113.10',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  secretEnc: encrypt('s3cret-pw'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.vpsTargetFindMany.mockResolvedValue([]);
  mocks.vpsTargetCreate.mockImplementation(async ({ data }: { data: object }) => ({
    ...TARGET_ROW,
    ...data,
    id: 'tgt-1',
  }));
});

// --- Prefix regression guard (Issue 1 from review) ---

describe('route prefix', () => {
  it('serves /api/vps-targets (not the doubled /api/vps-targets/vps-targets)', async () => {
    const app = await buildApp();
    const ok = await app.inject({ method: 'GET', url: '/api/vps-targets', ...AUTH });
    expect(ok.statusCode).toBe(200);
    // The bug would have made this the real path — assert it is NOT mounted there.
    const doubled = await app.inject({ method: 'GET', url: '/api/vps-targets/vps-targets', ...AUTH });
    expect(doubled.statusCode).toBe(404);
  });
});

// --- GET /api/vps-targets ---

describe('GET /api/vps-targets', () => {
  it('requires auth', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/vps-targets' });
    expect(res.statusCode).toBe(401);
  });

  it('returns targets scoped to the user, without secretEnc', async () => {
    mocks.vpsTargetFindMany.mockResolvedValue([TARGET_ROW]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/vps-targets', ...AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0].secretEnc).toBeUndefined();
    expect(body.targets[0].hasSecret).toBe(true);
  });
});

// --- POST /api/vps-targets ---

describe('POST /api/vps-targets', () => {
  it('creates a password-auth target and encrypts the secret', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/vps-targets',
      payload: PASSWORD_BODY,
      ...AUTH,
    });
    expect(res.statusCode).toBe(201);
    const created = mocks.vpsTargetCreate.mock.calls[0]![0].data;
    expect(created.name).toBe('prod-box');
    expect(created.secretEnc).not.toBe('s3cret-pw');
    expect(decrypt(created.secretEnc)).toBe('s3cret-pw');
    // Response never includes the ciphertext.
    expect(res.json().target.secretEnc).toBeUndefined();
    expect(res.json().target.hasSecret).toBe(true);
  });

  it('creates a key-auth target', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/vps-targets',
      payload: KEY_BODY,
      ...AUTH,
    });
    expect(res.statusCode).toBe(201);
    const created = mocks.vpsTargetCreate.mock.calls[0]![0].data;
    expect(created.authMethod).toBe('key');
    expect(decrypt(created.secretEnc)).toContain('BEGIN OPENSSH');
  });

  it('defaults port to 22 and authMethod to password', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/vps-targets',
      payload: { name: 't', host: 'h.example.com', username: 'u', secret: 'pw' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(201);
    const data = mocks.vpsTargetCreate.mock.calls[0]![0].data;
    expect(data.port).toBe(22);
    expect(data.authMethod).toBe('password');
  });

  it('400s on invalid body (missing secret)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/vps-targets',
      payload: { name: 't', host: 'h.example.com', username: 'u' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(400);
  });
});

// --- PATCH /api/vps-targets/:id ---

describe('PATCH /api/vps-targets/:id', () => {
  it('updates fields without replacing the secret when omitted', async () => {
    mocks.vpsTargetFindFirst.mockResolvedValue({ id: 'tgt-1' });
    mocks.vpsTargetUpdate.mockResolvedValue(TARGET_ROW);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/vps-targets/tgt-1',
      payload: { name: 'renamed', host: '203.0.113.10', port: 22, username: 'deploy', authMethod: 'password' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = mocks.vpsTargetUpdate.mock.calls[0]![0].data;
    expect(data.name).toBe('renamed');
    expect(data.secretEnc).toBeUndefined();
  });

  it('replaces the secret when one is provided', async () => {
    mocks.vpsTargetFindFirst.mockResolvedValue({ id: 'tgt-1' });
    mocks.vpsTargetUpdate.mockResolvedValue(TARGET_ROW);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/vps-targets/tgt-1',
      payload: { name: 'prod-box', host: '203.0.113.10', port: 22, username: 'deploy', authMethod: 'password', secret: 'new-pw' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(200);
    const data = mocks.vpsTargetUpdate.mock.calls[0]![0].data;
    expect(decrypt(data.secretEnc)).toBe('new-pw');
  });

  it('404s when the target belongs to another user', async () => {
    mocks.vpsTargetFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/vps-targets/tgt-other',
      payload: { name: 'renamed', host: '203.0.113.10', port: 22, username: 'deploy', authMethod: 'password' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(404);
  });
});

// --- DELETE /api/vps-targets/:id ---

describe('DELETE /api/vps-targets/:id', () => {
  it('deletes the target and cascades services back to lemniscate', async () => {
    mocks.vpsTargetFindFirst.mockResolvedValue({ id: 'tgt-1' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/vps-targets/tgt-1',
      ...AUTH,
    });
    expect(res.statusCode).toBe(204);
    expect(mocks.serviceUpdateMany).toHaveBeenCalledWith({
      where: { vpsTargetId: 'tgt-1' },
      data: { vpsTargetId: null, deployTarget: 'lemniscate' },
    });
    expect(mocks.vpsTargetDelete).toHaveBeenCalledWith({ where: { id: 'tgt-1' } });
  });

  it('404s when the target belongs to another user', async () => {
    mocks.vpsTargetFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/vps-targets/tgt-other',
      ...AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(mocks.vpsTargetDelete).not.toHaveBeenCalled();
  });
});

// --- POST /api/vps-targets/:id/test (saved target) ---

describe('POST /api/vps-targets/:id/test', () => {
  it('probes a saved target using decrypted credentials', async () => {
    mocks.vpsTargetFindFirst.mockResolvedValue(TARGET_ROW);
    mocks.testVpsConnection.mockResolvedValue({ ok: true, echo: 'lemniscate-ok' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/vps-targets/tgt-1/test',
      ...AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, echo: 'lemniscate-ok' });
    const call = mocks.testVpsConnection.mock.calls[0];
    expect(call![0]).toMatchObject({ host: '203.0.113.10', port: 22, username: 'deploy' });
    expect(call![1]).toBe('s3cret-pw'); // decrypted
  });

  it('404s when the target belongs to another user', async () => {
    mocks.vpsTargetFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/vps-targets/tgt-other/test',
      ...AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(mocks.testVpsConnection).not.toHaveBeenCalled();
  });
});

// --- POST /api/vps-targets/test (unsaved target) ---

describe('POST /api/vps-targets/test', () => {
  it('probes an unsaved target from the request body', async () => {
    mocks.testVpsConnection.mockResolvedValue({ ok: true, echo: 'lemniscate-ok' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/vps-targets/test',
      payload: PASSWORD_BODY,
      ...AUTH,
    });
    expect(res.statusCode).toBe(200);
    const call = mocks.testVpsConnection.mock.calls[0];
    expect(call![0]).toMatchObject({ host: '203.0.113.10', port: 22, username: 'deploy' });
    expect(call![1]).toBe('s3cret-pw');
  });

  it('400s on missing secret', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/vps-targets/test',
      payload: { name: 't', host: 'h.example.com', username: 'u' },
      ...AUTH,
    });
    expect(res.statusCode).toBe(400);
  });
});
