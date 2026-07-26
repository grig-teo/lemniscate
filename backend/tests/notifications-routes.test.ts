import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for /api/notifications: list + unread count, ownership-scoped
// mark-read, read-all, and the webhook settings endpoints. prisma is mocked;
// auth follows the devices.test.ts pattern (signed cookie for user-1).

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  userUpdate: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationCount: vi.fn(),
  notificationUpdateMany: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      findUniqueOrThrow: mocks.userFindUniqueOrThrow,
      update: mocks.userUpdate,
    },
    notification: {
      findMany: mocks.notificationFindMany,
      count: mocks.notificationCount,
      updateMany: mocks.notificationUpdateMany,
    },
  },
}));

import notificationsRoutes from '../src/routes/notifications.js';
import { signAuthToken } from '../src/plugins/auth.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.notificationFindMany.mockResolvedValue([ROW]);
  mocks.notificationCount.mockResolvedValue(1);
  mocks.notificationUpdateMany.mockResolvedValue({ count: 1 });
  mocks.userFindUniqueOrThrow.mockResolvedValue({ webhookUrl: null, webhookSecretEnc: null });
  mocks.userUpdate.mockImplementation(async ({ data }: { data: object }) => ({
    webhookUrl: null,
    webhookSecretEnc: null,
    ...data,
  }));
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
    expect(mocks.notificationFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
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
    expect(mocks.notificationUpdateMany).toHaveBeenCalledWith({
      where: { id: 'n1', userId: 'user-1', readAt: null },
      data: { readAt: expect.any(Date) },
    });
    expect(response.json()).toEqual({ updated: 1 });
  });

  it('is a no-op for a foreign notification id', async () => {
    mocks.notificationUpdateMany.mockResolvedValue({ count: 0 });
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/notifications/n9/read', ...AUTH });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ updated: 0 });
  });
});

describe('POST /api/notifications/read-all', () => {
  it('marks every unread notification of the user read', async () => {
    mocks.notificationUpdateMany.mockResolvedValue({ count: 3 });
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/notifications/read-all', ...AUTH });
    expect(response.statusCode).toBe(200);
    expect(mocks.notificationUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', readAt: null },
      data: { readAt: expect.any(Date) },
    });
    expect(response.json()).toEqual({ updated: 3 });
  });
});

describe('webhook settings', () => {
  it('GET returns nulls when nothing is configured', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/notifications/settings', ...AUTH });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ webhookUrl: null, webhookSecret: null });
  });

  it('PUT stores the URL and mints a secret on first configuration', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/notifications/settings',
      payload: { webhookUrl: 'https://hooks.example.com/bridge' },
      ...AUTH,
    });
    expect(response.statusCode).toBe(200);
    const update = mocks.userUpdate.mock.calls[0][0] as {
      data: { webhookUrl: string; webhookSecretEnc: string };
    };
    expect(update.data.webhookUrl).toBe('https://hooks.example.com/bridge');
    const body = response.json();
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    // Stored encrypted; the API returns the plaintext so the user can wire
    // their bridge. Round-trips through lib/crypto.
    expect(decrypt(update.data.webhookSecretEnc)).toBe(body.webhookSecret);
  });

  it('PUT keeps the existing secret when one is already stored', async () => {
    mocks.userFindUniqueOrThrow.mockResolvedValue({ webhookSecretEnc: encrypt('keepme') });
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/notifications/settings',
      payload: { webhookUrl: 'https://hooks.example.com/other' },
      ...AUTH,
    });
    expect(response.statusCode).toBe(200);
    const update = mocks.userUpdate.mock.calls[0][0] as { data: { webhookSecretEnc: string } };
    expect(decrypt(update.data.webhookSecretEnc)).toBe('keepme');
  });

  it('PUT rejects non-http(s) URLs', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/notifications/settings',
      payload: { webhookUrl: 'ftp://example.com/hook' },
      ...AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('PUT null clears the webhook URL', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/notifications/settings',
      payload: { webhookUrl: null },
      ...AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ webhookUrl: null }) }),
    );
  });
});
