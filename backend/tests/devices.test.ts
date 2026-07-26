import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for /api/devices: pairing, claim, device management and
// command dispatch, with prisma mocked and the device hub driven by fake
// sockets. The WS message handlers are covered in devices-ws.test.ts.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  pairingDeleteMany: vi.fn(),
  pairingCreate: vi.fn(),
  pairingFindUnique: vi.fn(),
  pairingDelete: vi.fn(),
  deviceCreate: vi.fn(),
  deviceFindUnique: vi.fn(),
  deviceFindMany: vi.fn(),
  deviceFindFirst: vi.fn(),
  deviceUpdate: vi.fn(),
  deviceDelete: vi.fn(),
  commandFindMany: vi.fn(),
  commandCreate: vi.fn(),
  commandUpdate: vi.fn(),
  storeDeviceArtifact: vi.fn(),
  deviceArtifactStream: vi.fn(),
  redisIncr: vi.fn(),
  redisExpire: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    devicePairing: {
      deleteMany: mocks.pairingDeleteMany,
      create: mocks.pairingCreate,
      findUnique: mocks.pairingFindUnique,
      delete: mocks.pairingDelete,
    },
    device: {
      create: mocks.deviceCreate,
      findUnique: mocks.deviceFindUnique,
      findMany: mocks.deviceFindMany,
      findFirst: mocks.deviceFindFirst,
      update: mocks.deviceUpdate,
      delete: mocks.deviceDelete,
    },
    deviceCommand: {
      findMany: mocks.commandFindMany,
      create: mocks.commandCreate,
      update: mocks.commandUpdate,
    },
  },
}));

// Keep the real pure key helpers (artifactKeyFor/artifactOwnerDeviceId/…)
// so the ownership check parses keys exactly as production does; only the
// MinIO-touching functions are stubbed.
vi.mock('../src/lib/device-artifacts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/device-artifacts.js')>()),
  storeDeviceArtifact: mocks.storeDeviceArtifact,
  deviceArtifactStream: mocks.deviceArtifactStream,
}));

vi.mock('../src/lib/redis.js', () => ({
  getRedisClient: () => ({ incr: mocks.redisIncr, expire: mocks.redisExpire }),
}));

import { config } from '../src/config.js';

import devicesRoutes from '../src/routes/devices.js';
import { deviceHub } from '../src/lib/device-hub.js';
import { hashDeviceToken } from '../src/lib/device-tokens.js';
import { signAuthToken } from '../src/plugins/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(websocket);
  await app.register(devicesRoutes, { prefix: '/api/devices' });
  return app;
}

const AUTH = { cookies: { lemniscate_token: signAuthToken('user-1', 0) } };

const COMMAND_BODY = {
  type: 'run_web',
  payload: { repoUrl: 'https://github.com/a/b', branch: 'main', port: 3000 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.pairingCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: 'p1', ...data }));
  mocks.deviceCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: 'dev-1', ...data }));
  mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1' });
  mocks.commandCreate.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'cmd-1',
    status: 'queued',
    ...data,
  }));
  mocks.redisIncr.mockResolvedValue(1);
  mocks.redisExpire.mockResolvedValue(1);
});

describe('POST /api/devices/pairings', () => {
  it('requires auth', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/devices/pairings' });
    expect(response.statusCode).toBe(401);
  });

  it('replaces previous pairings and returns a 6-char code with expiry', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/devices/pairings', ...AUTH });
    expect(response.statusCode).toBe(201);
    expect(mocks.pairingDeleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    const body = response.json();
    expect(body.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('POST /api/devices/claim', () => {
  function claim(app: Awaited<ReturnType<typeof buildApp>>, code = 'ABC234') {
    return app.inject({
      method: 'POST',
      url: '/api/devices/claim',
      payload: { code, name: 'pixel', platform: 'android' },
    });
  }

  it('404s an unknown code', async () => {
    mocks.pairingFindUnique.mockResolvedValue(null);
    const app = await buildApp();
    expect((await claim(app)).statusCode).toBe(404);
    expect(mocks.deviceCreate).not.toHaveBeenCalled();
  });

  it('401s an expired code', async () => {
    mocks.pairingFindUnique.mockResolvedValue({
      id: 'p1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 1000),
    });
    const app = await buildApp();
    expect((await claim(app)).statusCode).toBe(401);
    expect(mocks.deviceCreate).not.toHaveBeenCalled();
  });

  it('400s a body with an invalid platform', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/devices/claim',
      payload: { code: 'ABC234', name: 'pixel', platform: 'toaster' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('creates the device with the hashed token and consumes the pairing', async () => {
    mocks.pairingFindUnique.mockResolvedValue({
      id: 'p1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const app = await buildApp();
    const response = await claim(app);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.deviceId).toBe('dev-1');
    expect(body.deviceToken).toMatch(/^[0-9a-f]{48}$/);
    expect(mocks.deviceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        tokenHash: hashDeviceToken(body.deviceToken),
      }),
    });
    expect(mocks.pairingDelete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });
});

describe('GET /api/devices', () => {
  it('requires auth', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/devices' })).statusCode).toBe(401);
  });

  it('lists only own devices with online flag and no tokenHash', async () => {
    mocks.deviceFindMany.mockResolvedValue([
      { id: 'dev-1', name: 'pixel', platform: 'android', meta: null, lastSeenAt: null, createdAt: new Date(0) },
    ]);
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/devices', ...AUTH });
    expect(response.statusCode).toBe(200);
    expect(mocks.deviceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    expect(response.body).not.toContain('tokenHash');
    expect(response.json().devices).toEqual([
      expect.objectContaining({ id: 'dev-1', online: false }),
    ]);
  });
});

describe('PATCH/DELETE /api/devices/:id', () => {
  it('404s rename for another user’s device', async () => {
    mocks.deviceFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/devices/dev-9',
      ...AUTH,
      payload: { name: 'new' },
    });
    expect(response.statusCode).toBe(404);
    expect(mocks.deviceUpdate).not.toHaveBeenCalled();
  });

  it('renames an owned device', async () => {
    mocks.deviceUpdate.mockResolvedValue({ id: 'dev-1', name: 'new' });
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/devices/dev-1',
      ...AUTH,
      payload: { name: 'new' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.deviceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dev-1' }, data: { name: 'new' } }),
    );
  });

  it('404s delete for another user’s device', async () => {
    mocks.deviceFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const response = await app.inject({ method: 'DELETE', url: '/api/devices/dev-9', ...AUTH });
    expect(response.statusCode).toBe(404);
    expect(mocks.deviceDelete).not.toHaveBeenCalled();
  });

  it('delete closes the hub socket and removes the device', async () => {
    const socket = { send: vi.fn(), close: vi.fn() };
    deviceHub.register('dev-del', socket);
    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-del', userId: 'user-1' });
    const app = await buildApp();
    const response = await app.inject({ method: 'DELETE', url: '/api/devices/dev-del', ...AUTH });
    expect(response.statusCode).toBe(200);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(deviceHub.isOnline('dev-del')).toBe(false);
    expect(mocks.deviceDelete).toHaveBeenCalledWith({ where: { id: 'dev-del' } });
  });
});

describe('device commands', () => {
  it('lists recent commands for the owner only', async () => {
    mocks.deviceFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const denied = await app.inject({ method: 'GET', url: '/api/devices/dev-9/commands', ...AUTH });
    expect(denied.statusCode).toBe(404);

    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1' });
    mocks.commandFindMany.mockResolvedValue([{ id: 'cmd-1' }]);
    const allowed = await app.inject({ method: 'GET', url: '/api/devices/dev-1/commands', ...AUTH });
    expect(allowed.statusCode).toBe(200);
    expect(mocks.commandFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deviceId: 'dev-1' }, take: 20 }),
    );
    expect(allowed.json().commands).toEqual([{ id: 'cmd-1' }]);
  });

  it('stays queued when the device is offline', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/devices/dev-1/commands',
      ...AUTH,
      payload: COMMAND_BODY,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().command.status).toBe('queued');
    expect(mocks.commandUpdate).not.toHaveBeenCalled();
  });

  it('sends immediately and marks sent when the device is online', async () => {
    const socket = { send: vi.fn(), close: vi.fn() };
    deviceHub.register('dev-online', socket);
    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-online', userId: 'user-1' });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/devices/dev-online/commands',
      ...AUTH,
      payload: COMMAND_BODY,
    });
    deviceHub.unregister('dev-online', socket);
    expect(response.statusCode).toBe(201);
    expect(response.json().command.status).toBe('sent');
    expect(JSON.parse(socket.send.mock.calls[0]?.[0] as string)).toEqual({
      id: 'cmd-1',
      type: 'run_web',
      payload: COMMAND_BODY.payload,
    });
    expect(mocks.commandUpdate).toHaveBeenCalledWith({
      where: { id: 'cmd-1' },
      data: { status: 'sent' },
    });
  });

  it('400s an invalid command payload', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/devices/dev-1/commands',
      ...AUTH,
      payload: { type: 'run_web', payload: { repoUrl: 'not-a-url' } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('install_apk commands', () => {
  const APK_BODY = {
    type: 'install_apk',
    payload: { apkUrl: 'https://example.com/app-release.apk', appName: 'My App' },
  };

  function postApk(app: Awaited<ReturnType<typeof buildApp>>, body: unknown = APK_BODY) {
    return app.inject({ method: 'POST', url: '/api/devices/dev-1/commands', ...AUTH, payload: body });
  }

  it('queues install_apk for an android device', async () => {
    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform: 'android' });
    const app = await buildApp();
    const response = await postApk(app);
    expect(response.statusCode).toBe(201);
    expect(mocks.commandCreate).toHaveBeenCalledWith({
      data: { deviceId: 'dev-1', type: 'install_apk', payload: APK_BODY.payload },
    });
  });

  it('accepts install_apk for a desktop device (download only)', async () => {
    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform: 'desktop' });
    const app = await buildApp();
    expect((await postApk(app)).statusCode).toBe(201);
  });

  it('400s install_apk on ios and web devices with a clear message', async () => {
    for (const platform of ['ios', 'web']) {
      mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform });
      const app = await buildApp();
      const response = await postApk(app);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain(platform);
      expect(mocks.commandCreate).not.toHaveBeenCalled();
    }
  });

  it('accepts install_apk targeting a specific adb device', async () => {
    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform: 'android' });
    const app = await buildApp();
    const body = {
      type: 'install_apk',
      payload: { ...APK_BODY.payload, deviceSerial: '192.168.1.5:5555' },
    };
    const response = await postApk(app, body);
    expect(response.statusCode).toBe(201);
    expect(mocks.commandCreate).toHaveBeenCalledWith({
      data: { deviceId: 'dev-1', type: 'install_apk', payload: body.payload },
    });
  });

  it.each(['abc; rm -rf ~', 'abc`id`', 'abc$(id)', 'abc def'])(
    '400s a shell-hostile deviceSerial %j',
    async (deviceSerial) => {
      mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform: 'android' });
      const app = await buildApp();
      const response = await postApk(app, {
        type: 'install_apk',
        payload: { ...APK_BODY.payload, deviceSerial },
      });
      expect(response.statusCode).toBe(400);
      expect(mocks.commandCreate).not.toHaveBeenCalled();
    },
  );

  it('400s an invalid apkUrl', async () => {
    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform: 'android' });
    const app = await buildApp();
    const response = await postApk(app, { type: 'install_apk', payload: { apkUrl: 'not-a-url' } });
    expect(response.statusCode).toBe(400);
  });
});

describe('build_android commands', () => {
  it('queues build_android with the user payload (server enriches at dispatch)', async () => {
    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform: 'desktop' });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/devices/dev-1/commands',
      ...AUTH,
      payload: { type: 'build_android', payload: { repoUrl: 'https://github.com/a/b', branch: 'main' } },
    });
    expect(response.statusCode).toBe(201);
    expect(mocks.commandCreate).toHaveBeenCalledWith({
      data: {
        deviceId: 'dev-1',
        type: 'build_android',
        payload: { repoUrl: 'https://github.com/a/b', branch: 'main' },
      },
    });
  });

  it('400s shell-hostile gradle names', async () => {
    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform: 'desktop' });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/devices/dev-1/commands',
      ...AUTH,
      payload: {
        type: 'build_android',
        payload: { repoUrl: 'https://github.com/a/b', branch: 'main', gradleTask: 'x; rm -rf /' },
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('run_desktop commands', () => {
  const RUN_DESKTOP_BODY = {
    type: 'run_desktop',
    payload: { repoUrl: 'https://github.com/a/b', branch: 'main', startScript: 'electron' },
  };

  function postRunDesktop(app: Awaited<ReturnType<typeof buildApp>>, body: unknown = RUN_DESKTOP_BODY) {
    return app.inject({ method: 'POST', url: '/api/devices/dev-1/commands', ...AUTH, payload: body });
  }

  it('queues run_desktop for a desktop device', async () => {
    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform: 'desktop' });
    const app = await buildApp();
    const response = await postRunDesktop(app);
    expect(response.statusCode).toBe(201);
    expect(mocks.commandCreate).toHaveBeenCalledWith({
      data: { deviceId: 'dev-1', type: 'run_desktop', payload: RUN_DESKTOP_BODY.payload },
    });
  });

  it('accepts run_desktop without a startScript (agent picks one)', async () => {
    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform: 'desktop' });
    const app = await buildApp();
    const response = await postRunDesktop(app, {
      type: 'run_desktop',
      payload: { repoUrl: 'https://github.com/a/b', branch: 'main' },
    });
    expect(response.statusCode).toBe(201);
  });

  it('400s run_desktop on android, ios and web devices with a clear message', async () => {
    for (const platform of ['android', 'ios', 'web']) {
      mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform });
      const app = await buildApp();
      const response = await postRunDesktop(app);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain(platform);
      expect(mocks.commandCreate).not.toHaveBeenCalled();
    }
  });

  it('400s a startScript with shell-hostile characters', async () => {
    mocks.deviceFindFirst.mockResolvedValue({ id: 'dev-1', userId: 'user-1', platform: 'desktop' });
    const app = await buildApp();
    for (const startScript of ['dev; rm -rf /', 'dev && x', 'dev prod', '$(evil)']) {
      const response = await postRunDesktop(app, {
        type: 'run_desktop',
        payload: { repoUrl: 'https://github.com/a/b', branch: 'main', startScript },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(mocks.commandCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/devices/artifacts', () => {
  function upload(app: Awaited<ReturnType<typeof buildApp>>, token?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/devices/artifacts?filename=my%20app.apk',
      headers: {
        'content-type': 'application/octet-stream',
        ...(token ? { authorization: `Device ${token}` } : {}),
      },
      payload: Buffer.from('fake-apk-bytes'),
    });
  }

  it('401s without a valid device token', async () => {
    mocks.deviceFindUnique.mockResolvedValue(null);
    const app = await buildApp();
    expect((await upload(app)).statusCode).toBe(401);
    expect((await upload(app, 'bad-token')).statusCode).toBe(401);
    expect(mocks.storeDeviceArtifact).not.toHaveBeenCalled();
  });

  it('stores the body under the authenticated device and returns the key', async () => {
    mocks.deviceFindUnique.mockResolvedValue({ id: 'dev-builder', userId: 'user-1' });
    mocks.storeDeviceArtifact.mockResolvedValue({ key: 'dev-builder/u1-my-app.apk' });
    const app = await buildApp();
    const response = await upload(app, 'good-token');
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ key: 'dev-builder/u1-my-app.apk' });
    expect(mocks.storeDeviceArtifact).toHaveBeenCalledWith(
      'dev-builder',
      'my app.apk',
      Buffer.from('fake-apk-bytes'),
      'application/vnd.android.package-archive',
    );
  });

  it('503s when artifact storage is unavailable', async () => {
    mocks.deviceFindUnique.mockResolvedValue({ id: 'dev-builder', userId: 'user-1' });
    mocks.storeDeviceArtifact.mockRejectedValue(new Error('MinIO is not configured'));
    const app = await buildApp();
    expect((await upload(app, 'good-token')).statusCode).toBe(503);
  });

  it('counts the upload against the device’s daily Redis quota', async () => {
    mocks.deviceFindUnique.mockResolvedValue({ id: 'dev-builder', userId: 'user-1' });
    mocks.storeDeviceArtifact.mockResolvedValue({ key: 'dev-builder/u1-my-app.apk' });
    const app = await buildApp();
    expect((await upload(app, 'good-token')).statusCode).toBe(201);
    expect(mocks.redisIncr).toHaveBeenCalledWith('artifact-quota:dev-builder');
  });

  it('429s when the daily artifact quota is exceeded and stores nothing', async () => {
    mocks.deviceFindUnique.mockResolvedValue({ id: 'dev-builder', userId: 'user-1' });
    mocks.redisIncr.mockResolvedValue(config.DEVICE_ARTIFACT_MAX_PER_DAY + 1);
    const app = await buildApp();
    const response = await upload(app, 'good-token');
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toContain('quota');
    expect(mocks.storeDeviceArtifact).not.toHaveBeenCalled();
  });
});

describe('GET /api/devices/artifacts/*', () => {
  function download(app: Awaited<ReturnType<typeof buildApp>>, token?: string, key = 'dev-builder/u1-app.apk') {
    return app.inject({
      method: 'GET',
      url: `/api/devices/artifacts/${key}`,
      headers: token ? { authorization: `Device ${token}` } : {},
    });
  }

  it('401s without a valid device token', async () => {
    mocks.deviceFindUnique.mockResolvedValue(null);
    const app = await buildApp();
    expect((await download(app)).statusCode).toBe(401);
    expect((await download(app, 'bad-token')).statusCode).toBe(401);
    expect(mocks.deviceArtifactStream).not.toHaveBeenCalled();
  });

  it('400s on traversal keys and 404s when the artifact is missing', async () => {
    mocks.deviceFindUnique.mockResolvedValue({ id: 'dev-1', userId: 'user-1' });
    mocks.deviceArtifactStream.mockResolvedValue(null);
    const app = await buildApp();
    expect((await download(app, 'good-token', '..%2F..%2Fetc')).statusCode).toBe(400);
    expect((await download(app, 'good-token')).statusCode).toBe(404);
  });

  it('400s when the key has no owner device segment', async () => {
    mocks.deviceFindUnique.mockResolvedValue({ id: 'dev-phone', userId: 'user-1' });
    const app = await buildApp();
    expect((await download(app, 'good-token', 'app.apk')).statusCode).toBe(400);
    expect(mocks.deviceArtifactStream).not.toHaveBeenCalled();
  });

  it('404s when the artifact belongs to another user\'s device', async () => {
    mocks.deviceFindUnique.mockImplementation(
      async ({ where }: { where: { tokenHash?: string; id?: string } }) =>
        where.id === 'dev-builder'
          ? { id: 'dev-builder', userId: 'user-2' }
          : { id: 'dev-phone', userId: 'user-1' },
    );
    const app = await buildApp();
    expect((await download(app, 'good-token')).statusCode).toBe(404);
    expect(mocks.deviceArtifactStream).not.toHaveBeenCalled();
  });

  it('404s when the owner device no longer exists', async () => {
    mocks.deviceFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id ? null : { id: 'dev-phone', userId: 'user-1' },
    );
    const app = await buildApp();
    expect((await download(app, 'good-token')).statusCode).toBe(404);
    expect(mocks.deviceArtifactStream).not.toHaveBeenCalled();
  });

  it('streams across devices of the same user', async () => {
    mocks.deviceFindUnique.mockImplementation(
      async ({ where }: { where: { tokenHash?: string; id?: string } }) =>
        where.id === 'dev-builder'
          ? { id: 'dev-builder', userId: 'user-1' }
          : { id: 'dev-phone', userId: 'user-1' },
    );
    mocks.deviceArtifactStream.mockResolvedValue({
      stream: Readable.from([Buffer.from('apk-bytes')]),
      size: 9,
    });
    const app = await buildApp();
    const response = await download(app, 'good-token');
    expect(response.statusCode).toBe(200);
    expect(mocks.deviceArtifactStream).toHaveBeenCalledWith('dev-builder/u1-app.apk');
  });

  it('streams the artifact for an authenticated device', async () => {
    mocks.deviceFindUnique.mockResolvedValue({ id: 'dev-phone', userId: 'user-1' });
    mocks.deviceArtifactStream.mockResolvedValue({
      stream: Readable.from([Buffer.from('apk-bytes')]),
      size: 9,
    });
    const app = await buildApp();
    const response = await download(app, 'good-token');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(response.body).toBe('apk-bytes');
    expect(mocks.deviceArtifactStream).toHaveBeenCalledWith('dev-builder/u1-app.apk');
  });
});
