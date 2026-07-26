import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for the pr-state-sync job: awaiting_review tasks whose PR was
// merged on the git host are marked done, closed-without-merge are marked
// closed; open PRs and provider failures leave the task untouched. prisma,
// the PR API, and event helpers are mocked so no DB/network is contacted.

const mocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  setTaskStatus: vi.fn().mockResolvedValue(undefined),
  logEvent: vi.fn().mockResolvedValue(undefined),
  cleanupWorkdir: vi.fn().mockResolvedValue(undefined),
  pullRequestState: vi.fn(),
}));

vi.mock('../src/config.js', () => ({ config: { AGENT_WORKDIR: '/tmp/test-workdirs' } }));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { task: { findMany: mocks.taskFindMany } },
}));
vi.mock('../src/lib/task-events.js', () => ({ setTaskStatus: mocks.setTaskStatus }));
vi.mock('../src/lib/agent-git.js', () => ({
  logEvent: mocks.logEvent,
  cleanupWorkdir: mocks.cleanupWorkdir,
}));
vi.mock('../src/lib/pull-requests.js', () => ({ pullRequestState: mocks.pullRequestState }));
vi.mock('../src/lib/proposal-scheduler.js', () => ({ getAgentTasksQueue: vi.fn() }));
vi.mock('ioredis', () => ({ Redis: vi.fn() }));

import { syncMergedPullRequests, taskStatusForPrState } from '../src/lib/pr-state-sync.js';

function awaitingTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    status: 'awaiting_review',
    prUrl: 'https://pr/1',
    branchName: 'lemniscate/t-1',
    repository: {
      fullName: 'org/demo',
      defaultBranch: 'main',
      connection: { provider: 'github', baseUrl: null, accessTokenEnc: 'enc' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('taskStatusForPrState', () => {
  it('maps merged to done, closed to closed, and leaves open unchanged', () => {
    expect(taskStatusForPrState('merged')).toBe('done');
    expect(taskStatusForPrState('open')).toBeNull();
    expect(taskStatusForPrState('closed')).toBe('closed');
  });
});

describe('syncMergedPullRequests', () => {
  it('marks a task done when its PR was merged on the git host', async () => {
    mocks.taskFindMany.mockResolvedValue([awaitingTask()]);
    mocks.pullRequestState.mockResolvedValue('merged');

    await syncMergedPullRequests();

    expect(mocks.pullRequestState).toHaveBeenCalledWith(
      awaitingTask().repository.connection,
      { repoFullName: 'org/demo', headBranch: 'lemniscate/t-1', baseBranch: 'main' },
    );
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('t1', 'done');
    expect(mocks.logEvent).toHaveBeenCalledWith(
      't1',
      'pull request merged on the git host — task marked done',
    );
    // The kept run workdir is removed once the task is merged.
    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith('/tmp/test-workdirs/t1', 't1');
  });

  it('leaves tasks with open PRs unchanged', async () => {
    mocks.taskFindMany.mockResolvedValue([awaitingTask({ id: 't-open' })]);
    mocks.pullRequestState.mockResolvedValue('open');
    await syncMergedPullRequests();

    expect(mocks.setTaskStatus).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(mocks.cleanupWorkdir).not.toHaveBeenCalled();
  });

  it('marks a task closed when its PR was closed without merge', async () => {
    mocks.taskFindMany.mockResolvedValue([awaitingTask({ id: 't-closed' })]);
    mocks.pullRequestState.mockResolvedValue('closed');
    await syncMergedPullRequests();

    expect(mocks.setTaskStatus).toHaveBeenCalledWith('t-closed', 'closed');
    expect(mocks.logEvent).toHaveBeenCalledWith(
      't-closed',
      'pull request closed without merge on the git host — task marked closed',
    );
    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith('/tmp/test-workdirs/t-closed', 't-closed');
  });

  it('skips provider failures and keeps syncing the remaining tasks', async () => {
    mocks.taskFindMany.mockResolvedValue([
      awaitingTask({ id: 't-broken' }),
      awaitingTask({ id: 't-merged' }),
    ]);
    mocks.pullRequestState
      .mockRejectedValueOnce(new Error('github: no pull request'))
      .mockResolvedValueOnce('merged');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await syncMergedPullRequests();

    expect(mocks.setTaskStatus).toHaveBeenCalledTimes(1);
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('t-merged', 'done');
    warn.mockRestore();
  });

  it('queries only unarchived awaiting_review tasks that have a PR and branch', async () => {
    mocks.taskFindMany.mockResolvedValue([]);
    await syncMergedPullRequests();
    expect(mocks.taskFindMany).toHaveBeenCalledWith({
      where: {
        status: 'awaiting_review',
        prUrl: { not: null },
        branchName: { not: null },
        archivedAt: null,
        repository: { connection: { disconnectedAt: null } },
      },
      include: { repository: { include: { connection: true } } },
    });
  });
});
