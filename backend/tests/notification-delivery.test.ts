import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the outbound notification dispatcher (lib/notifications.ts
// emitters + lib/notification-delivery.ts transport): channel fan-out with
// event filtering, BullMQ-retried HMAC-signed webhook delivery, the SSRF
// guard, payload secret redaction, email-skip without SMTP config, the
// logJobFailure hook, and synchronous test sends. prisma, the queue,
// url-safety, fetch, and nodemailer are mocked — no network or DB.

const mocks = vi.hoisted(() => ({
  config: {
    ENCRYPTION_KEY: '0'.repeat(64),
    SMTP_HOST: undefined as string | undefined,
    SMTP_PORT: 587,
    SMTP_USER: undefined as string | undefined,
    SMTP_PASS: undefined as string | undefined,
    SMTP_FROM: 'Lemniscate <notifications@example.com>',
  },
  settingFindMany: vi.fn(),
  settingFindUnique: vi.fn(),
  deliveryCreate: vi.fn(),
  deliveryUpdate: vi.fn(),
  deliveryFindUnique: vi.fn(),
  notificationCreate: vi.fn(),
  notificationFindFirst: vi.fn(),
  taskFindUnique: vi.fn(),
  repositoryFindUnique: vi.fn(),
  llmConfigFindMany: vi.fn(),
  queueAdd: vi.fn(),
  assertPublicHttpUrl: vi.fn(),
  fetch: vi.fn(),
  sendMail: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock('../src/config.js', () => ({ config: mocks.config, MONITORED_SECRETS: [] }));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    notificationSetting: {
      findMany: mocks.settingFindMany,
      findUnique: mocks.settingFindUnique,
    },
    notificationDelivery: {
      create: mocks.deliveryCreate,
      update: mocks.deliveryUpdate,
      findUnique: mocks.deliveryFindUnique,
    },
    notification: {
      create: mocks.notificationCreate,
      findFirst: mocks.notificationFindFirst,
    },
    task: { findUnique: mocks.taskFindUnique },
    repository: { findUnique: mocks.repositoryFindUnique },
    llmConfig: { findMany: mocks.llmConfigFindMany },
  },
}));
vi.mock('../src/lib/queue.js', () => ({
  getAgentTasksQueue: () => ({ add: mocks.queueAdd }),
}));
vi.mock('../src/lib/url-safety.js', () => ({
  assertPublicHttpUrl: mocks.assertPublicHttpUrl,
}));
vi.mock('nodemailer', () => ({
  createTransport: mocks.createTransport,
}));
vi.stubGlobal('fetch', mocks.fetch);

import { encrypt } from '../src/lib/crypto.js';
import {
  notify,
  notifyJobFailure,
  notifyTaskCompleted,
  signWebhookBody,
  WEBHOOK_SIGNATURE_HEADER,
} from '../src/lib/notifications.js';
import {
  deliverNotification,
  DELIVERY_JOB_NAME,
  sendTestNotification,
} from '../src/lib/notification-delivery.js';

const SETTING = {
  id: 's1',
  userId: 'user-1',
  channel: 'webhook',
  target: 'https://hooks.example.com/bridge',
  secretEnc: encrypt('whsec'),
  events: ['pr_opened', 'run_failed'],
  enabled: true,
};

const DELIVERY = {
  id: 'd1',
  settingId: 's1',
  notificationId: 'n1',
  event: 'pr_opened',
  status: 'queued',
  attempts: 0,
  payload: JSON.stringify({ event: 'pr_opened', title: 't', body: 'b', deliveryId: 'd1' }),
  setting: SETTING,
};

function lastUpdate(): { where: { id: string }; data: Record<string, unknown> } {
  return mocks.deliveryUpdate.mock.calls.at(-1)?.[0] as never;
}

function lastCreate(): { data: Record<string, unknown> } {
  return mocks.deliveryCreate.mock.calls.at(-1)?.[0] as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.SMTP_HOST = undefined;
  mocks.notificationCreate.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'n1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...data,
  }));
  mocks.notificationFindFirst.mockResolvedValue(null);
  mocks.llmConfigFindMany.mockResolvedValue([]);
  mocks.settingFindMany.mockResolvedValue([]);
  mocks.settingFindUnique.mockResolvedValue(SETTING);
  mocks.deliveryCreate.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'd1',
    ...data,
  }));
  mocks.deliveryFindUnique.mockResolvedValue(DELIVERY);
  mocks.queueAdd.mockResolvedValue({ id: 'job-1' });
  mocks.fetch.mockResolvedValue({ ok: true, status: 200 });
  mocks.assertPublicHttpUrl.mockResolvedValue(undefined);
  mocks.sendMail.mockResolvedValue({});
  mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
});

describe('notify channel fan-out', () => {
  it('creates a queued delivery and enqueues a retried job per subscribed channel', async () => {
    mocks.settingFindMany.mockResolvedValue([SETTING]);

    await notify('user-1', 'pr_opened', {
      title: 'PR opened: t',
      body: 'org/demo',
      taskId: 't1',
      prUrl: 'https://pr/1',
    });

    expect(mocks.settingFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', enabled: true, events: { has: 'pr_opened' } },
    });
    expect(mocks.deliveryCreate).toHaveBeenCalledTimes(1);
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      DELIVERY_JOB_NAME,
      { deliveryId: 'd1' },
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }),
    );
  });

  it('stores the full payload in a single create (no empty-payload window)', async () => {
    mocks.settingFindMany.mockResolvedValue([SETTING]);

    await notify('user-1', 'pr_opened', { title: 't', body: 'b', taskId: 't1' });

    const stored = JSON.parse(lastCreate().data.payload as string);
    expect(stored).toMatchObject({
      event: 'pr_opened',
      title: 't',
      body: 'b',
      taskId: 't1',
      notificationId: 'n1',
    });
    // The delivery id does not exist at create time — it is stamped into
    // the outbound body at delivery time, so the audit row never holds an
    // empty placeholder payload.
    expect(stored.deliveryId).toBeUndefined();
    expect(mocks.deliveryUpdate).not.toHaveBeenCalled();
  });

  it('redacts the channel HMAC secret from the outbound payload', async () => {
    mocks.settingFindMany.mockResolvedValue([SETTING]);

    await notify('user-1', 'pr_opened', { title: 'leaked whsec here', body: 'b' });

    const stored = JSON.parse(lastCreate().data.payload as string);
    expect(stored.title).toBe('leaked [redacted] here');
    expect(JSON.stringify(stored)).not.toContain('whsec');
  });

  it('does not enqueue when no channel subscribes to the event', async () => {
    await notify('user-1', 'pr_opened', { title: 't', body: 'b' });
    expect(mocks.deliveryCreate).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it('still records the in-app row when channel dispatch fails', async () => {
    mocks.settingFindMany.mockRejectedValue(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notify('user-1', 'pr_opened', { title: 't', body: 'b' })).resolves.toBeUndefined();
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe('deliverNotification', () => {
  it('POSTs the stored payload with the event and HMAC signature headers', async () => {
    await deliverNotification('d1', 0);

    expect(mocks.assertPublicHttpUrl).toHaveBeenCalledWith('https://hooks.example.com/bridge');
    const [url, init] = mocks.fetch.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://hooks.example.com/bridge');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(DELIVERY.payload);
    expect(init.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(signWebhookBody('whsec', init.body));
    expect(lastUpdate().data).toMatchObject({
      status: 'delivered',
      attempts: 1,
      lastStatusCode: 200,
      lastError: null,
    });
  });

  it('stamps the delivery id into the POSTed body at delivery time', async () => {
    mocks.deliveryFindUnique.mockResolvedValue({
      ...DELIVERY,
      payload: JSON.stringify({ event: 'pr_opened', title: 't', body: 'b' }),
    });

    await deliverNotification('d1', 0);

    const [, init] = mocks.fetch.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ event: 'pr_opened', deliveryId: 'd1' });
  });

  it('does not follow redirects after the SSRF check — a 3xx is a failed delivery', async () => {
    // A public URL passing assertPublicHttpUrl could 302 to an internal
    // address (169.254.169.254 etc.); fetch must not follow it.
    mocks.fetch.mockResolvedValue({ ok: false, status: 302 });

    await expect(deliverNotification('d1', 0)).rejects.toThrow('302');

    const [, init] = mocks.fetch.mock.calls[0] as unknown as [string, { redirect?: string }];
    expect(init.redirect).toBe('manual');
    expect(lastUpdate().data).toMatchObject({ status: 'queued', lastStatusCode: 302 });
  });

  it('throws on HTTP 5xx with attempts remaining so BullMQ retries', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(deliverNotification('d1', 0)).rejects.toThrow('500');
    expect(lastUpdate().data).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastStatusCode: 500,
    });
  });

  it('marks the delivery failed without throwing on the final attempt', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(deliverNotification('d1', 2)).resolves.toBeUndefined();
    expect(lastUpdate().data).toMatchObject({ status: 'failed', attempts: 3, lastStatusCode: 500 });
  });

  it('treats a network error like a 5xx (retry, then fail)', async () => {
    mocks.fetch.mockRejectedValue(new Error('socket hang up'));

    await expect(deliverNotification('d1', 1)).rejects.toThrow('socket hang up');
    expect(lastUpdate().data).toMatchObject({
      status: 'queued',
      attempts: 2,
      lastStatusCode: null,
      lastError: 'socket hang up',
    });
  });

  it('fails the delivery when the SSRF guard rejects the target', async () => {
    mocks.assertPublicHttpUrl.mockRejectedValue(new Error('private address'));

    await expect(deliverNotification('d1', 2)).resolves.toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(lastUpdate().data).toMatchObject({ status: 'failed', lastError: 'private address' });
  });

  it('skips email channels when SMTP is not configured', async () => {
    mocks.deliveryFindUnique.mockResolvedValue({
      ...DELIVERY,
      setting: { ...SETTING, channel: 'email', target: 'ops@example.com', secretEnc: null },
    });

    await expect(deliverNotification('d1', 0)).resolves.toBeUndefined();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(lastUpdate().data.status).toBe('skipped');
    expect(String(lastUpdate().data.lastError)).toMatch(/SMTP/);
  });

  it('sends email through nodemailer when SMTP is configured', async () => {
    mocks.config.SMTP_HOST = 'smtp.example.com';
    mocks.deliveryFindUnique.mockResolvedValue({
      ...DELIVERY,
      setting: { ...SETTING, channel: 'email', target: 'ops@example.com', secretEnc: null },
    });

    await deliverNotification('d1', 0);

    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 587 }),
    );
    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ops@example.com', subject: 't' }),
    );
    expect(lastUpdate().data).toMatchObject({ status: 'delivered', lastStatusCode: null });
  });

  it('is a no-op for a missing delivery row', async () => {
    mocks.deliveryFindUnique.mockResolvedValue(null);
    await deliverNotification('ghost', 0);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.deliveryUpdate).not.toHaveBeenCalled();
  });
});

describe('sendTestNotification', () => {
  it('delivers synchronously, records a test delivery, and reports the result', async () => {
    const result = await sendTestNotification('s1', 'user-1');

    expect(mocks.settingFindUnique).toHaveBeenCalledWith({
      where: { id: 's1', userId: 'user-1' },
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.deliveryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ settingId: 's1', event: 'test', status: 'delivered' }),
    });
    expect(result).toEqual({ ok: true, statusCode: 200, error: null });
  });

  it('reports HTTP failures without throwing', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 502 });
    const result = await sendTestNotification('s1', 'user-1');
    expect(result).toEqual({ ok: false, statusCode: 502, error: expect.stringContaining('502') });
  });

  it('refuses a channel owned by another user', async () => {
    mocks.settingFindUnique.mockResolvedValue(null);
    const result = await sendTestNotification('s1', 'user-2');
    expect(result).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('notifyTaskCompleted', () => {
  const DONE_TASK = {
    status: 'done',
    title: 'Fix the thing',
    repository: { fullName: 'org/demo', connection: { userId: 'user-1' } },
  };

  it('notifies the owner when the task reached done', async () => {
    mocks.taskFindUnique.mockResolvedValue(DONE_TASK);
    await notifyTaskCompleted('t1');
    expect(mocks.notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        kind: 'task_completed',
        taskId: 't1',
        title: 'Task completed: Fix the thing',
      }),
    });
  });

  it('does nothing while the task is not terminal', async () => {
    mocks.taskFindUnique.mockResolvedValue({ ...DONE_TASK, status: 'awaiting_review' });
    await notifyTaskCompleted('t1');
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });
});

describe('notifyJobFailure', () => {
  it('notifies the repository owner for repository-scoped job failures', async () => {
    mocks.repositoryFindUnique.mockResolvedValue({
      fullName: 'org/demo',
      connection: { userId: 'user-1' },
    });

    await notifyJobFailure({
      jobName: 'deploy-service',
      errorKind: 'Error',
      message: 'LLM request failed: invalid api key',
      repositoryId: 'r1',
    });

    expect(mocks.notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        kind: 'job_failed',
        title: 'Job failed: deploy-service',
      }),
    });
  });

  it('dedupes while an unread job_failed notification exists for the same job', async () => {
    mocks.repositoryFindUnique.mockResolvedValue({
      fullName: 'org/demo',
      connection: { userId: 'user-1' },
    });
    mocks.notificationFindFirst.mockResolvedValue({ id: 'n-existing' });

    await notifyJobFailure({
      jobName: 'deploy-service',
      errorKind: 'Error',
      message: 'boom',
      repositoryId: 'r1',
    });

    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });

  it('skips generate-proposals (handled by the dedicated proposal_generation_failed path)', async () => {
    mocks.repositoryFindUnique.mockResolvedValue({
      fullName: 'org/demo',
      connection: { userId: 'user-1' },
    });

    await notifyJobFailure({
      jobName: 'generate-proposals',
      errorKind: 'Error',
      message: 'boom',
      repositoryId: 'r1',
    });

    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });

  it('routes task-scoped failures through the task failure path', async () => {
    mocks.taskFindUnique.mockResolvedValue({
      title: 'Fix the thing',
      repository: { fullName: 'org/demo', connection: { userId: 'user-1' } },
    });

    await notifyJobFailure({ jobName: 'merge-gate', errorKind: 'Error', message: 'boom', taskId: 't1' });

    expect(mocks.notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'run_failed', taskId: 't1' }),
    });
  });

  it('does nothing when no owner can be resolved', async () => {
    mocks.repositoryFindUnique.mockResolvedValue(null);
    await notifyJobFailure({
      jobName: 'deploy-service',
      errorKind: 'Error',
      message: 'boom',
      repositoryId: 'ghost',
    });
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });
});
