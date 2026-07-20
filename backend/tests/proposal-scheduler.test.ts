import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for the BullMQ enqueue helpers and the global proposals-topup
// schedule. BullMQ, ioredis and prisma are mocked so no real Redis/DB is
// contacted; we only assert what would be enqueued.

const mocks = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue(undefined),
  upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
  taskGroupBy: vi.fn(),
  repositoryFindMany: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.add;
    upsertJobScheduler = mocks.upsertJobScheduler;
  },
}));
vi.mock('ioredis', () => ({ Redis: vi.fn() }));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    task: { groupBy: mocks.taskGroupBy },
    repository: { findMany: mocks.repositoryFindMany },
  },
}));

import {
  enqueueGenerateProposalsNow,
  enqueueProposalTopUps,
  registerProposalTopUpSchedule,
} from '../src/lib/proposal-scheduler.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueGenerateProposalsNow', () => {
  it('enqueues a one-shot generate-proposals job with a dedupe jobId', async () => {
    await enqueueGenerateProposalsNow('repo-1');
    expect(mocks.add).toHaveBeenCalledWith(
      'generate-proposals',
      { repositoryId: 'repo-1' },
      expect.objectContaining({ jobId: 'generate-proposals:repo-1' }),
    );
  });

  // Regression: removeOnComplete/removeOnFail as counts kept the finished
  // job around, so BullMQ silently swallowed every later enqueue with the
  // same jobId (the UI generate button worked only once per repo).
  it('removes finished jobs so re-enqueues for the same repo are not swallowed', async () => {
    await enqueueGenerateProposalsNow('repo-1');
    expect(mocks.add).toHaveBeenCalledWith(
      'generate-proposals',
      { repositoryId: 'repo-1' },
      expect.objectContaining({ removeOnComplete: true, removeOnFail: true }),
    );
  });
});

describe('registerProposalTopUpSchedule', () => {
  it('registers one global repeatable proposals-topup job every 6h', async () => {
    await registerProposalTopUpSchedule();
    expect(mocks.upsertJobScheduler).toHaveBeenCalledWith(
      'proposals-topup',
      { every: 6 * 60 * 60 * 1000 },
      { name: 'proposals-topup', data: {} },
    );
  });
});

describe('enqueueProposalTopUps', () => {
  it('enqueues generation only for repos below 5 pending proposals', async () => {
    mocks.repositoryFindMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
    mocks.taskGroupBy.mockResolvedValue([
      { repositoryId: 'r1', _count: { repositoryId: 2 } },
      { repositoryId: 'r2', _count: { repositoryId: 5 } },
    ]);
    await enqueueProposalTopUps();
    const repoIds = mocks.add.mock.calls.map((call) => call[1].repositoryId);
    expect(repoIds).toEqual(['r1', 'r3']);
  });
});
