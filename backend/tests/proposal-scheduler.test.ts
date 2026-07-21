import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for the BullMQ enqueue helpers and the global proposals-topup
// schedule. BullMQ, ioredis and prisma are mocked so no real Redis/DB is
// contacted; we only assert what would be enqueued.

const mocks = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue(undefined),
  upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
  taskGroupBy: vi.fn(),
  taskFindMany: vi.fn(),
  taskFindFirst: vi.fn(),
  taskCount: vi.fn(),
  taskUpdate: vi.fn(),
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
    task: {
      groupBy: mocks.taskGroupBy,
      findMany: mocks.taskFindMany,
      findFirst: mocks.taskFindFirst,
      count: mocks.taskCount,
      update: mocks.taskUpdate,
    },
    repository: { findMany: mocks.repositoryFindMany },
  },
}));

import {
  enqueueRunTask,
  enqueueGenerateProposalsNow,
  enqueueProposalAutoRuns,
  enqueueProposalTopUps,
  recoverQueuedTasks,
  registerProposalAutoRunSchedule,
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
      expect.objectContaining({ jobId: 'generate-proposals-repo-1' }),
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
  it('registers one global repeatable proposals-topup job every 10 minutes', async () => {
    await registerProposalTopUpSchedule();
    expect(mocks.upsertJobScheduler).toHaveBeenCalledWith(
      'proposals-topup',
      { every: 10 * 60 * 1000 },
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

  it('skips bare (codeless) repositories even when understocked', async () => {
    mocks.repositoryFindMany.mockResolvedValue([
      { id: 'r1', bare: false },
      { id: 'r2', bare: true },
    ]);
    mocks.taskGroupBy.mockResolvedValue([]);
    await enqueueProposalTopUps();
    const repoIds = mocks.add.mock.calls.map((call) => call[1].repositoryId);
    expect(repoIds).toEqual(['r1']);
  });
});

// Worker-startup recovery: tasks left in 'queued' without a BullMQ job
// (e.g. an enqueue that failed after the status update) are re-enqueued.
describe('recoverQueuedTasks', () => {
  it('re-enqueues run-task for every queued task', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    await recoverQueuedTasks();
    expect(mocks.taskFindMany).toHaveBeenCalledWith({
      where: { status: 'queued' },
      select: { id: true },
    });
    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(mocks.add).toHaveBeenCalledWith(
      'run-task',
      { taskId: 't1' },
      expect.objectContaining({ jobId: 'run-task-t1' }),
    );
  });

  it('is a no-op when nothing is queued', async () => {
    mocks.taskFindMany.mockResolvedValue([]);
    await recoverQueuedTasks();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});

// Regression: run-task/review-pr enqueues must drop finished job records
// immediately — with removeOnComplete/Fail as counts, re-running a task
// that already ran once was silently deduped away (status flipped to
// 'queued', no job, task stranded forever).
describe('enqueueRunTask', () => {
  it('removes finished jobs so reruns are not swallowed', async () => {
    await enqueueRunTask('task-1');
    expect(mocks.add).toHaveBeenCalledWith(
      'run-task',
      { taskId: 'task-1' },
      expect.objectContaining({ removeOnComplete: true, removeOnFail: true }),
    );
  });
});

// proposals-autorun job: for repos with autoRunProposals on, start the oldest
// pending proposal every 20 min — but only when no proposal of that repo is
// queued/running yet.
describe('enqueueProposalAutoRuns', () => {
  it('queries only repos with the flag on', async () => {
    mocks.repositoryFindMany.mockResolvedValue([]);
    await enqueueProposalAutoRuns();
    expect(mocks.repositoryFindMany).toHaveBeenCalledWith({
      where: { autoRunProposals: true },
      select: { id: true },
    });
  });

  it('starts the oldest pending proposal when none is queued or running', async () => {
    mocks.repositoryFindMany.mockResolvedValue([{ id: 'r1' }]);
    mocks.taskCount.mockResolvedValue(0);
    mocks.taskFindFirst.mockResolvedValue({ id: 'p1' });
    await enqueueProposalAutoRuns();
    expect(mocks.taskFindFirst).toHaveBeenCalledWith({
      where: { repositoryId: 'r1', kind: 'proposal', status: 'pending' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { status: 'queued' },
    });
    expect(mocks.add).toHaveBeenCalledWith(
      'run-task',
      { taskId: 'p1' },
      expect.objectContaining({ jobId: 'run-task-p1' }),
    );
  });

  it('skips repos that already have a proposal queued or running', async () => {
    mocks.repositoryFindMany.mockResolvedValue([{ id: 'r1' }]);
    mocks.taskCount.mockResolvedValue(1);
    await enqueueProposalAutoRuns();
    expect(mocks.taskFindFirst).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('skips repos with no pending proposals', async () => {
    mocks.repositoryFindMany.mockResolvedValue([{ id: 'r1' }]);
    mocks.taskCount.mockResolvedValue(0);
    mocks.taskFindFirst.mockResolvedValue(null);
    await enqueueProposalAutoRuns();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});

describe('registerProposalAutoRunSchedule', () => {
  it('registers the repeatable job every 20 minutes', async () => {
    await registerProposalAutoRunSchedule();
    expect(mocks.upsertJobScheduler).toHaveBeenCalledWith(
      'proposals-autorun',
      { every: 20 * 60 * 1000 },
      { name: 'proposals-autorun', data: {} },
    );
  });
});
