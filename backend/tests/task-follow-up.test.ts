import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for follow-up-task chaining (task-follow-up.ts):
//   * startFollowUpTask — enqueues a still-pending same-repo follow-up when a
//     task reaches 'done', then clears the pointer so a done task never
//     chains twice. The eligibility check (pending + same repo + active) is
//     re-evaluated at trigger time: an archived, non-pending, or cross-repo
//     target is skipped (no enqueue, no clear).
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
// enqueueRunTask is imported from proposal-scheduler.js (single home), so the
// mock must target that module — not task-queue.js.
vi.mock('../src/lib/proposal-scheduler.js', () => ({
  enqueueRunTask: mocks.enqueue,
}));

import { startFollowUpTask } from '../src/lib/task-follow-up.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskUpdate.mockResolvedValue(undefined);
  mocks.enqueue.mockResolvedValue(undefined);
});

describe('startFollowUpTask', () => {
  it('enqueues a pending same-repo follow-up and clears the pointer', async () => {
    mocks.taskFindFirst.mockResolvedValue({ id: 'next-task' });
    await startFollowUpTask('done-task', 'repo-1', 'follow-up-id');

    expect(mocks.taskFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'follow-up-id',
        status: 'pending',
        repositoryId: 'repo-1',
        archivedAt: null,
      },
      select: { id: true },
    });
    expect(mocks.enqueue).toHaveBeenCalledWith('next-task');
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'done-task' },
      data: { followUpTaskId: null },
    });
  });

  it('skips an ineligible follow-up (started, archived, or wrong repo) without enqueueing', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    await startFollowUpTask('done-task', 'repo-1', 'follow-up-id');

    expect(mocks.enqueue).not.toHaveBeenCalled();
    // Pointer is left intact so a later manual retry can pick it up.
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it('does nothing when no follow-up is set', async () => {
    await startFollowUpTask('done-task', 'repo-1', null);
    expect(mocks.taskFindFirst).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });
});
