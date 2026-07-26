import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for lib/notifications.ts: row creation, failure-kind mapping,
// unread dedupe against BullMQ retry spam, and the webhook signing helper.
// Outbound channel fan-out is covered in notification-delivery.test.ts;
// here the channel query simply returns no settings. prisma is mocked.

const mocks = vi.hoisted(() => ({
  notificationCreate: vi.fn(),
  notificationFindFirst: vi.fn(),
  settingFindMany: vi.fn(),
  deliveryCreate: vi.fn(),
  taskFindUnique: vi.fn(),
  queueAdd: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    notification: {
      create: mocks.notificationCreate,
      findFirst: mocks.notificationFindFirst,
    },
    notificationSetting: { findMany: mocks.settingFindMany },
    notificationDelivery: { create: mocks.deliveryCreate },
    task: { findUnique: mocks.taskFindUnique },
  },
}));
vi.mock('../src/lib/queue.js', () => ({
  getAgentTasksQueue: () => ({ add: mocks.queueAdd }),
}));
vi.stubGlobal('fetch', mocks.fetch);

import {
  generateWebhookSecret,
  NOTIFICATION_KINDS,
  notify,
  notifyTaskFailure,
  signWebhookBody,
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
  mocks.settingFindMany.mockResolvedValue([]);
  mocks.taskFindUnique.mockResolvedValue(TASK);
});

describe('signWebhookBody', () => {
  it('produces a stable GitHub-style sha256 HMAC of the exact body', () => {
    const signature = signWebhookBody('secret', '{"a":1}');
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signWebhookBody('secret', '{"a":1}')).toBe(signature);
    expect(signWebhookBody('other', '{"a":1}')).not.toBe(signature);
  });
});

describe('generateWebhookSecret', () => {
  it('mints 32 bytes of hex', () => {
    expect(generateWebhookSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });
});

describe('NOTIFICATION_KINDS', () => {
  it('covers every wired producer event', () => {
    for (const kind of [
      'pr_opened',
      'pr_merged',
      'pr_closed',
      'run_failed',
      'budget_exceeded',
      'task_completed',
      'merge_gate_failed',
      'job_failed',
    ]) {
      expect(NOTIFICATION_KINDS).toContain(kind);
    }
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

  it('swallows dispatch failures (never fails the producer)', async () => {
    mocks.settingFindMany.mockRejectedValue(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notify('user-1', 'run_failed', { title: 't', body: 'b' })).resolves.toBeUndefined();
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(1);
    error.mockRestore();
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
