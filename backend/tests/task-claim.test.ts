import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for the run-task atomic claim: exactly one concurrent
// executor may flip a task into 'running'. A duplicate delivery (BullMQ
// stalled re-delivery, or a second enqueue that slipped past jobId dedupe)
// loses the conditional updateMany and must stand down.

const mocks = vi.hoisted(() => ({
  taskUpdateMany: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { task: { updateMany: mocks.taskUpdateMany } },
}));
vi.mock('../src/lib/logger.js', () => ({ logger: mocks.logger }));

import { claimTaskForRun, RUN_CLAIMABLE_STATUSES } from '../src/lib/task-claim.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskUpdateMany.mockResolvedValue({ count: 1 });
});

describe('claimTaskForRun', () => {
  it('flips a claimable task to running and returns true', async () => {
    await expect(claimTaskForRun('task-1')).resolves.toBe(true);
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: 'task-1', status: { in: [...RUN_CLAIMABLE_STATUSES] } },
      data: { status: 'running' },
    });
  });

  it('claims only from restartable states (queued/pending), never from running', async () => {
    // 'running' must NOT be claimable: a stalled re-delivery would otherwise
    // claim a task the original executor is still working on. Recovery paths
    // reset dead 'running' tasks to 'queued' before re-enqueueing instead.
    await claimTaskForRun('task-1');
    expect(RUN_CLAIMABLE_STATUSES).toEqual(['queued', 'pending']);
    expect(RUN_CLAIMABLE_STATUSES).not.toContain('running');
  });

  it('returns false and logs when another executor already owns the task', async () => {
    mocks.taskUpdateMany.mockResolvedValue({ count: 0 });
    await expect(claimTaskForRun('task-1')).resolves.toBe(false);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1' }),
      expect.stringContaining('already claimed'),
    );
  });
});
