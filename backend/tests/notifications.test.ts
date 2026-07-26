import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for lib/notifications.ts: row creation, failure-kind mapping,
// unread dedupe against BullMQ retry spam, and webhook delivery (HMAC
// signature, best-effort failures). prisma and fetch are mocked; url-safety
// is stubbed so no DNS is touched.

const mocks = vi.hoisted(() => ({
  notificationCreate: vi.fn(),
  notificationFindFirst: vi.fn(),
  taskFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    notification: {
      create: mocks.notificationCreate,
      findFirst: mocks.notificationFindFirst,
    },
    task: { findUnique: mocks.taskFindUnique },
    user: { findUnique: mocks.userFindUnique },
  },
}));
vi.mock('../src/lib/url-safety.js', () => ({ assertPublicHttpUrl: vi.fn() }));
vi.stubGlobal('fetch', mocks.fetch);

import {
  notify,
  notifyTaskFailure,
  signWebhookBody,
  WEBHOOK_SIGNATURE_HEADER,
} from '../src/lib/notifications.js';

const TASK = {
  title: 'Fix the thing',
  repository: { fullName: 'org/demo', connection: { userId: 'user-1' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notificationCreate.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'n1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...data,
  }));
  mocks.notificationFindFirst.mockResolvedValue(null);
  mocks.taskFindUnique.mockResolvedValue(TASK);
  mocks.userFindUnique.mockResolvedValue({ webhookUrl: null, webhookSecretEnc: null });
  mocks.fetch.mockResolvedValue({ ok: true, status: 200 });
});

describe('signWebhookBody', () => {
  it('produces a stable GitHub-style sha256 HMAC of the exact body', () => {
    const signature = signWebhookBody('secret', '{"a":1}');
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signWebhookBody('secret', '{"a":1}')).toBe(signature);
    expect(signWebhookBody('other', '{"a":1}')).not.toBe(signature);
  });
});

describe('notify', () => {
  it('writes the row scoped to the user with optional task/pr links', async () => {
    await notify('user-1', 'pr_opened', {
      title: 'PR opened: Fix the thing',
      body: 'org/demo — awaiting review',
      taskId: 't1',
      prUrl: 'https://pr/1',
    });
    expect(mocks.notificationCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        kind: 'pr_opened',
        title: 'PR opened: Fix the thing',
        body: 'org/demo — awaiting review',
        taskId: 't1',
        prUrl: 'https://pr/1',
      },
    });
  });

  it('delivers an HMAC-signed webhook when the user configured one', async () => {
    // encrypt() round-trips through the test ENCRYPTION_KEY (vitest env).
    const { encrypt } = await import('../src/lib/crypto.js');
    mocks.userFindUnique.mockResolvedValue({
      webhookUrl: 'https://hooks.example.com/bridge',
      webhookSecretEnc: encrypt('whsec'),
    });

    await notify('user-1', 'pr_merged', { title: 't', body: 'b', taskId: 't1' });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://hooks.example.com/bridge');
    expect(init.method).toBe('POST');
    expect(init.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(signWebhookBody('whsec', init.body));
    expect(JSON.parse(init.body)).toMatchObject({ kind: 'pr_merged', taskId: 't1' });
  });

  it('skips the webhook when none is configured', async () => {
    await notify('user-1', 'pr_closed', { title: 't', body: 'b' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('swallows webhook delivery failures (never fails the producer)', async () => {
    const { encrypt } = await import('../src/lib/crypto.js');
    mocks.userFindUnique.mockResolvedValue({
      webhookUrl: 'https://hooks.example.com/bridge',
      webhookSecretEnc: encrypt('whsec'),
    });
    mocks.fetch.mockRejectedValue(new Error('socket hang up'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(notify('user-1', 'run_failed', { title: 't', body: 'b' })).resolves.toBeUndefined();
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('notifyTaskFailure', () => {
  it('maps plain errors to run_failed for the task owner', async () => {
    await notifyTaskFailure('t1', 'Error', 'boom');
    expect(mocks.notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        kind: 'run_failed',
        taskId: 't1',
        title: 'Run failed: Fix the thing',
      }),
    });
  });

  it('maps TokenBudgetExceededError to its own kind', async () => {
    await notifyTaskFailure('t1', 'TokenBudgetExceededError', 'budget exceeded (10 > 5)');
    expect(mocks.notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'budget_exceeded',
        title: 'Token budget exceeded: Fix the thing',
      }),
    });
  });

  it('dedupes while an unread notification for the same task+kind exists', async () => {
    mocks.notificationFindFirst.mockResolvedValue({ id: 'n-existing' });
    await notifyTaskFailure('t1', 'Error', 'boom');
    expect(mocks.notificationFindFirst).toHaveBeenCalledWith({
      where: { taskId: 't1', kind: 'run_failed', readAt: null },
      select: { id: true },
    });
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown task', async () => {
    mocks.taskFindUnique.mockResolvedValue(null);
    await notifyTaskFailure('ghost', 'Error', 'boom');
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });
});
