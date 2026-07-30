import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tests for the manual follow-up task feature:
//   - POST /tasks/:id/follows handler: setting/clearing the nextTaskId link,
//     same-repository + ownership enforcement, self-reference rejection, and
//     body validation.
//   - triggerNextTask firing logic (lib/task-next.ts): a pending successor is
//     auto-queued (status flipped to 'queued' + enqueued) when its
//     predecessor reaches 'done'; a non-idle successor is skipped; the link is
//     cleared after firing (idempotent); a dangling link is dropped; the
//     successor's status is set to 'queued' so it never lingers as 'pending'
//     with a queued job.

// ---------------------------------------------------------------------------
// Shared prisma mocks. The handler uses task.findFirst (predecessor + successor
// lookups) and task.update (set/clear); triggerNextTask uses findUnique
// (predecessor + successor), updateMany (queued claim) and update (clear link).
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn(),
  taskUpdateMany: vi.fn(),
  enqueueRunTask: vi.fn(),
  logEvent: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    // requireAuth validates the token against the user record.
    user: { findUnique: mocks.userFindUnique },
    task: {
      findFirst: mocks.taskFindFirst,
      findUnique: mocks.taskFindUnique,
      update: mocks.taskUpdate,
      updateMany: mocks.taskUpdateMany,
    },
  },
}));
vi.mock('../src/lib/proposal-scheduler.js', () => ({
  enqueueRunTask: mocks.enqueueRunTask,
}));
vi.mock('../src/lib/agent-git.js', () => ({ logEvent: mocks.logEvent }));

// task-events is imported transitively (config/auth chain); stub it out so the
// Redis publisher is never touched from a unit test.
vi.mock('ioredis', () => ({
  Redis: class MockRedis {
    publish = mocks.publish;
  },
}));

import tasksRoutes from '../src/routes/tasks.js';
import { triggerNextTask } from '../src/lib/task-next.js';
import { signAuthToken } from '../src/plugins/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(tasksRoutes, { prefix: '/api' });
  return app;
}

const AUTH = { cookies: { lemniscate_token: signAuthToken('user-1', 0) } } as const;

function follows(
  app: Awaited<ReturnType<typeof buildApp>>,
  taskId: string,
  body: unknown,
) {
  return app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/follows`,
    payload: body,
    ...AUTH,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enqueueRunTask.mockResolvedValue(undefined);
  mocks.logEvent.mockResolvedValue(undefined);
  // requireAuth succeeds for the authenticated test user.
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
});

// ===========================================================================
// POST /tasks/:id/follows — set / clear the manual successor link.
// ===========================================================================
describe('POST /api/tasks/:id/follows', () => {
  beforeEach(() => {
    // Default: an owned predecessor exists in repo-1.
    mocks.taskFindFirst.mockResolvedValue({
      id: 'predecessor',
      repositoryId: 'repo-1',
    });
    mocks.taskUpdate.mockImplementation(async ({ data }: { data: object }) => ({
      id: 'predecessor',
      nextTaskId: 'nextTaskId' in data ? (data as { nextTaskId: string | null }).nextTaskId : null,
    }));
  });

  it('sets the successor link when the successor is in the same repo', async () => {
    // First findFirst = predecessor; second = successor (same repo, owned).
    mocks.taskFindFirst
      .mockResolvedValueOnce({ id: 'predecessor', repositoryId: 'repo-1' })
      .mockResolvedValueOnce({ id: 'successor' });

    const app = await buildApp();
    const response = await follows(app, 'predecessor', { nextTaskId: 'successor' });

    expect(response.statusCode).toBe(200);
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'predecessor' },
      data: { nextTaskId: 'successor' },
    });
    expect(response.json().task.nextTaskId).toBe('successor');
  });

  it('clears the link when nextTaskId is null', async () => {
    const app = await buildApp();
    const response = await follows(app, 'predecessor', { nextTaskId: null });

    expect(response.statusCode).toBe(200);
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'predecessor' },
      data: { nextTaskId: null },
    });
    // No successor lookup is performed when clearing.
    expect(mocks.taskFindFirst).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the predecessor is not found / not owned', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    const app = await buildApp();

    const response = await follows(app, 'predecessor', { nextTaskId: 'successor' });

    expect(response.statusCode).toBe(404);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('rejects a successor in a different repository', async () => {
    mocks.taskFindFirst
      .mockResolvedValueOnce({ id: 'predecessor', repositoryId: 'repo-1' })
      .mockResolvedValueOnce(null); // successor lookup misses (cross-repo)

    const app = await buildApp();
    const response = await follows(app, 'predecessor', { nextTaskId: 'other-repo-task' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/this repository/i);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('rejects a self-reference', async () => {
    mocks.taskFindFirst.mockResolvedValue({ id: 'me', repositoryId: 'repo-1' });
    const app = await buildApp();

    const response = await follows(app, 'me', { nextTaskId: 'me' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/cannot follow itself/i);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('rejects an invalid body', async () => {
    const app = await buildApp();

    const response = await follows(app, 'predecessor', { nextTaskId: 123 });

    expect(response.statusCode).toBe(400);
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// triggerNextTask — firing the manual successor chain on 'done'.
// ===========================================================================
describe('triggerNextTask', () => {
  beforeEach(() => {
    mocks.taskUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('queues an idle (pending) successor, clears the link, and returns its id', async () => {
    mocks.taskFindUnique
      .mockResolvedValueOnce({ nextTaskId: 'successor' }) // predecessor
      .mockResolvedValueOnce({ id: 'successor', status: 'pending', title: 'T' }); // successor

    const result = await triggerNextTask('predecessor');

    expect(result).toBe('successor');
    // Status is flipped to 'queued' guarded on the validated idle status.
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: 'successor', status: 'pending' },
      data: { status: 'queued' },
    });
    expect(mocks.enqueueRunTask).toHaveBeenCalledWith('successor');
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'successor',
      'auto-started as the follow-up to predecessor',
    );
    // The link is cleared on the predecessor (idempotent on rerun).
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'predecessor' },
      data: { nextTaskId: null },
    });
  });

  it('also accepts a successor that is already queued', async () => {
    mocks.taskFindUnique
      .mockResolvedValueOnce({ nextTaskId: 'successor' })
      .mockResolvedValueOnce({ id: 'successor', status: 'queued', title: 'T' });

    const result = await triggerNextTask('predecessor');

    expect(result).toBe('successor');
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: 'successor', status: 'queued' },
      data: { status: 'queued' },
    });
    expect(mocks.enqueueRunTask).toHaveBeenCalledWith('successor');
  });

  it('skips a successor that is no longer idle (already running)', async () => {
    mocks.taskFindUnique
      .mockResolvedValueOnce({ nextTaskId: 'successor' })
      .mockResolvedValueOnce({ id: 'successor', status: 'running', title: 'T' });

    const result = await triggerNextTask('predecessor');

    expect(result).toBeNull();
    expect(mocks.enqueueRunTask).not.toHaveBeenCalled();
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled();
    // A skipped successor leaves the predecessor's link intact.
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('skips a successor that already finished (terminal)', async () => {
    mocks.taskFindUnique
      .mockResolvedValueOnce({ nextTaskId: 'successor' })
      .mockResolvedValueOnce({ id: 'successor', status: 'done', title: 'T' });

    const result = await triggerNextTask('predecessor');

    expect(result).toBeNull();
    expect(mocks.enqueueRunTask).not.toHaveBeenCalled();
  });

  it('does nothing when the predecessor has no successor', async () => {
    mocks.taskFindUnique.mockResolvedValueOnce({ nextTaskId: null });

    const result = await triggerNextTask('predecessor');

    expect(result).toBeNull();
    expect(mocks.enqueueRunTask).not.toHaveBeenCalled();
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('clears the link when the successor has been deleted', async () => {
    mocks.taskFindUnique
      .mockResolvedValueOnce({ nextTaskId: 'gone' }) // predecessor
      .mockResolvedValueOnce(null); // successor vanished

    const result = await triggerNextTask('predecessor');

    expect(result).toBeNull();
    expect(mocks.enqueueRunTask).not.toHaveBeenCalled();
    // Dangling link is dropped so it never fires again.
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'predecessor' },
      data: { nextTaskId: null },
    });
  });

  it('does not enqueue when the successor state changed before the claim', async () => {
    mocks.taskFindUnique
      .mockResolvedValueOnce({ nextTaskId: 'successor' })
      .mockResolvedValueOnce({ id: 'successor', status: 'pending', title: 'T' });
    // The user started it between the select and the claim: 0 rows updated.
    mocks.taskUpdateMany.mockResolvedValue({ count: 0 });

    const result = await triggerNextTask('predecessor');

    expect(result).toBeNull();
    expect(mocks.enqueueRunTask).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('never throws — failures are logged and best-effort', async () => {
    mocks.taskFindUnique.mockRejectedValue(new Error('db down'));

    await expect(triggerNextTask('predecessor')).resolves.toBeNull();
    expect(mocks.enqueueRunTask).not.toHaveBeenCalled();
  });
});
