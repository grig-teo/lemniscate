import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for follow-up-task chaining helpers (task-follow-up.ts):
//   * resolveFollowUp — a still-pending same-repo follow-up task is eligible
//     to run; an archived, non-pending, or cross-repo one is not (returns null).
//   * startFollowUpTask — enqueues the resolved follow-up and clears the
//     pointer so a done task never chains twice.
// The enqueue helper and prisma are mocked so no DB/queue is contacted.

const mocks = vi.hoisted(() => ({
  taskFindFirst: vi.fn(),
  taskUpdate: vi.fn().mockResolvedValue(undefined),
  enqueue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    task: { findFirst: mocks.taskFindFirst, update: mocks.taskUpdate },
  },
}));
vi.mock('../src/lib/task-queue.js', () => ({
  enqueueRunTask: mocks.enqueue,
}));

import { resolveFollowUp, startFollowUpTask } from '../src/lib/task-follow-up.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskUpdate.mockResolvedValue(undefined);
  mocks.enqueue.mockResolvedValue(undefined);
});

describe('resolveFollowUp', () => {
  it('returns a still-pending same-repo follow-up', async () => {
    mocks.taskFindFirst.mockResolvedValue({ id: 'next-task' });
    const next = await resolveFollowUp('done-task', 'repo-1');
    expect(next).toBe('next-task');
    expect(mocks.taskFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'follow-up-id',
        status: 'pending',
        repositoryId: 'repo-1',
        archivedAt: null,
      },
      select: { id: true },
    });
  });

  it('returns null when the follow-up was started, archived, or removed', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    expect(await resolveFollowUp('done-task', 'repo-1')).toBeNull();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe('startFollowUpTask', () => {
  it('enqueues a pending follow-up and clears the pointer', async () => {
    mocks.taskFindFirst.mockResolvedValue({ id: 'next-task' });
    await startFollowUpTask('done-task', 'repo-1', 'follow-up-id');

    expect(mocks.enqueue).toHaveBeenCalledWith('next-task');
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'done-task' },
      data: { followUpTaskId: null },
    });
  });

  it('does nothing when no follow-up is set', async () => {
    await startFollowUpTask('done-task', 'repo-1', null);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });
});
