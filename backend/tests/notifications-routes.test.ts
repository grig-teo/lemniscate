import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for /api/notifications: list + unread count, ownership-scoped
// mark-read, read-all, and the outbound channel CRUD + test-send endpoints.
// prisma is mocked; auth follows the devices.test.ts pattern (signed cookie
// for user-1). url-safety is stubbed so no DNS is touched; the delivery
// module keeps its real signing helpers but a mocked test-send.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationCount: vi.fn(),
  notificationUpdateMany: vi.fn(),
  settingFindMany: vi.fn(),
  settingFindUnique: vi.fn(),
  settingCreate: vi.fn(),
  settingUpdate: vi.fn(),
  settingDeleteMany: vi.fn(),
  deliveryFindMany: vi.fn(),
  deliveryFindFirst: vi.fn(),
  assertPublicHttpUrl: vi.fn(),
  sendTestNotification: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    notification: {
      findMany: mocks.notificationFindMany,
      count: mocks.notificationCount,
      updateMany: mocks.notificationUpdateMany,
    },
    notificationSetting: {
      findMany: mocks.settingFindMany,
      findUnique: mocks.settingFindUnique,
      create: mocks.settingCreate,
      update: mocks.settingUpdate,
      deleteMany: mocks.settingDeleteMany,
    },
    notificationDelivery: {
      findMany: mocks.deliveryFindMany,
      findFirst: mocks.deliveryFindFirst,
    },
  },
}));
vi.mock('../src/lib/url-safety.js', () => ({
  assertPublicHttpUrl: mocks.assertPublicHttpUrl,
}));
vi.mock('../src/lib/notification-delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/notification-delivery.js')>();
  return { ...actual, sendTestNotification: mocks.sendTestNotification };
});

import notificationsRoutes from '../src/routes/notifications.js';
import { signAuthToken } from '../src/plugins/auth.js';
import { decrypt } from '../src/lib/crypto.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(notificationsRoutes, { prefix: '/api/notifications' });
  return app;
}

const AUTH = { cookies: { lemniscate_token: signAuthToken('user-1', 0) } };

const ROW = {
  id: 'n1',
  userId: 'user-1',
  kind: 'pr_opened',
  title: 'PR opened: t',
  body: 'org/demo',
  taskId: 't1',
  prUrl: 'https://pr/1',
  readAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const SETTING = {
  id: 's1',
  userId: 'user-1',
  channel: 'webhook',
  target: 'https://hooks.example.com/bridge',
  secretEnc: null,
  events: ['pr_opened'],
  enabled: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.notificationFindMany.mockResolvedValue([ROW]);
  mocks.notificationCount.mockResolvedValue(1);
  mocks.notificationUpdateMany.mockResolvedValue({ count: 1 });
  mocks.settingFindMany.mockResolvedValue([SETTING]);
  mocks.settingFindUnique.mockResolvedValue(SETTING);
  mocks.settingCreate.mockImplementation(async ({ data }: { data: object }) => ({
    ...SETTING,
    ...data,
  }));
  mocks.settingUpdate.mockImplementation(async ({ data }: { data: object }) => ({
    ...SETTING,
    ...data,
  }));
  mocks.settingDeleteMany.mockResolvedValue({ count: 1 });
  mocks.deliveryFindMany.mockResolvedValue([]);
  mocks.deliveryFindFirst.mockResolvedValue(null);
  mocks.assertPublicHttpUrl.mockResolvedValue(undefined);
  mocks.sendTestNotification.mockResolvedValue({ ok: true, statusCode: 200, error: null });
});

describe('GET /api/notifications', () => {
  it('requires auth', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/notifications' });
    expect(response.statusCode).toBe(401);
  });

  it('lists the user notifications plus the unread count', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/notifications', ...AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.unreadCount).toBe(1);
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({ id: 'n1', kind: 'pr_opened', prUrl: 'https://pr/1' });
  });

  it('filters to unread with ?unread=true', async () => {
    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/api/notifications?unread=true', ...AUTH });
    expect(mocks.notificationFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', readAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('marks the notification read scoped to the owning user', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/notifications/n1/read', ...AUTH });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ updated: 1 });
  });
});

describe('POST /api/notifications/read-all', () => {
  it('marks every unread notification of the user read', async () => {
    mocks.notificationUpdateMany.mockResolvedValue({ count: 3 });
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/notifications/read-all', ...AUTH });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ updated: 3 });
  });
});

describe('GET /api/notifications/channels', () => {
  it('lists the user channels with the last delivery outcome', async () => {
    mocks.deliveryFindFirst.mockResolvedValue({
      id: 'd1',
      event: 'pr_opened',
      status: 'delivered',
      lastStatusCode: 200,
      lastError: null,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/notifications/channels', ...AUTH });
    expect(response.statusCode).toBe(200);
    expect(mocks.settingFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'asc' },
    });
    const body = response.json();
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({
      id: 's1',
      channel: 'webhook',
      target: 'https://hooks.example.com/bridge',
      events: ['pr_opened'],
      enabled: true,
      webhookSecret: null,
      lastDelivery: { status: 'delivered', lastStatusCode: 200 },
    });
  });
});

describe('POST /api/notifications/channels', () => {
  it('creates a webhook channel, minting an encrypted HMAC secret', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      payload: {
        channel: 'webhook',
        target: 'https://hooks.example.com/bridge',
        events: ['pr_opened', 'run_failed'],
      },
      ...AUTH,
    });
    expect(response.statusCode).toBe(201);
    expect(mocks.assertPublicHttpUrl).toHaveBeenCalledWith('https://hooks.example.com/bridge');
    const created = mocks.settingCreate.mock.calls[0][0] as {
      data: { userId: string; channel: string; secretEnc: string; events: string[] };
    };
    expect(created.data.userId).toBe('user-1');
    expect(created.data.events).toEqual(['pr_opened', 'run_failed']);
    const body = response.json();
    expect(body.channel.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    // Stored AES-256-GCM encrypted; the API returns the plaintext so the
    // user can wire their bridge.
    expect(decrypt(created.data.secretEnc)).toBe(body.channel.webhookSecret);
  });

  it('creates an email channel without a secret', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      payload: { channel: 'email', target: 'ops@example.com', events: ['job_failed'] },
      ...AUTH,
    });
    expect(response.statusCode).toBe(201);
    const created = mocks.settingCreate.mock.calls[0][0] as { data: { secretEnc: string | null } };
    expect(created.data.secretEnc).toBeNull();
  });

  it('rejects a webhook target the SSRF guard blocks', async () => {
    mocks.assertPublicHttpUrl.mockRejectedValue(new Error('private address'));
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      payload: { channel: 'webhook', target: 'https://10.0.0.4/hook', events: ['pr_opened'] },
      ...AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.settingCreate).not.toHaveBeenCalled();
  });

  it('rejects an invalid email target', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      payload: { channel: 'email', target: 'not-an-email', events: ['job_failed'] },
      ...AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.settingCreate).not.toHaveBeenCalled();
  });

  it('rejects unknown event kinds', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      payload: { channel: 'webhook', target: 'https://hooks.example.com/x', events: ['nope'] },
      ...AUTH,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('PATCH /api/notifications/channels/:id', () => {
  it('updates events and enabled for the owning user', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/channels/s1',
      payload: { enabled: false, events: ['run_failed'] },
      ...AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.settingUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { enabled: false, events: ['run_failed'] },
    });
  });

  it('404s for a foreign channel', async () => {
    mocks.settingFindUnique.mockResolvedValue(null);
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/channels/s9',
      payload: { enabled: false },
      ...AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(mocks.settingUpdate).not.toHaveBeenCalled();
  });

  it('re-validates the SSRF guard when the target changes', async () => {
    mocks.assertPublicHttpUrl.mockRejectedValue(new Error('private address'));
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/channels/s1',
      payload: { target: 'https://192.168.0.1/hook' },
      ...AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.settingUpdate).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/notifications/channels/:id', () => {
  it('deletes scoped to the owning user', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/notifications/channels/s1',
      ...AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.settingDeleteMany).toHaveBeenCalledWith({ where: { id: 's1', userId: 'user-1' } });
    expect(response.json()).toEqual({ deleted: 1 });
  });
});

describe('POST /api/notifications/channels/:id/test', () => {
  it('round-trips a synchronous test delivery', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels/s1/test',
      ...AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.sendTestNotification).toHaveBeenCalledWith('s1', 'user-1');
    expect(response.json()).toEqual({ ok: true, statusCode: 200, error: null });
  });

  it('404s when the channel belongs to another user', async () => {
    mocks.sendTestNotification.mockResolvedValue(null);
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels/s9/test',
      ...AUTH,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/notifications/channels/:id/deliveries', () => {
  it('lists recent deliveries for an owned channel', async () => {
    mocks.deliveryFindMany.mockResolvedValue([
      {
        id: 'd1',
        event: 'pr_opened',
        status: 'delivered',
        attempts: 1,
        lastStatusCode: 200,
        lastError: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
    ]);
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/channels/s1/deliveries',
      ...AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.deliveryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { settingId: 's1' }, take: 20 }),
    );
    expect(response.json().deliveries).toHaveLength(1);
  });

  it('404s for a foreign channel', async () => {
    mocks.settingFindUnique.mockResolvedValue(null);
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/channels/s9/deliveries',
      ...AUTH,
    });
    expect(response.statusCode).toBe(404);
  });
});
