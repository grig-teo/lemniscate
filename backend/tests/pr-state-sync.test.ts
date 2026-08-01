import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for the pr-state-sync job: awaiting_review tasks whose PR was
// merged on the git host are marked done, closed-without-merge are marked
// closed; open PRs and provider failures leave the task untouched. prisma,
// the PR API, and event helpers are mocked so no DB/network is contacted.

const mocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  taskUpdate: vi.fn(),
  taskEventCount: vi.fn().mockResolvedValue(0),
  taskEventFindFirst: vi.fn().mockResolvedValue(null),
  taskEventFindMany: vi.fn().mockResolvedValue([]),
  enqueueReviewTask: vi.fn().mockResolvedValue(undefined),
  enqueueRunTask: vi.fn().mockResolvedValue(undefined),
  enqueueAddressReview: vi.fn().mockResolvedValue(undefined),
  setTaskStatus: vi.fn().mockResolvedValue(undefined),
  logEvent: vi.fn().mockResolvedValue(undefined),
  cleanupWorkdir: vi.fn().mockResolvedValue(undefined),
  pullRequestState: vi.fn(),
  listPullRequests: vi.fn(),
  listPrReviewComments: vi.fn(),
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/config.js', () => ({
  config: { AGENT_WORKDIR: '/tmp/test-workdirs', PR_STATE_SYNC_INTERVAL_MS: 12_345 },
}));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    task: { findMany: mocks.taskFindMany, update: mocks.taskUpdate },
    taskEvent: {
      count: mocks.taskEventCount,
      findFirst: mocks.taskEventFindFirst,
      findMany: mocks.taskEventFindMany,
    },
  },
}));
vi.mock('../src/lib/task-events.js', () => ({ setTaskStatus: mocks.setTaskStatus }));
vi.mock('../src/lib/agent-git.js', () => ({
  logEvent: mocks.logEvent,
  cleanupWorkdir: mocks.cleanupWorkdir,
}));
vi.mock('../src/lib/pull-requests.js', () => ({
  pullRequestState: mocks.pullRequestState,
  listPullRequests: mocks.listPullRequests,
  listPrReviewComments: mocks.listPrReviewComments,
}));
vi.mock('../src/lib/notifications.js', () => ({ notify: mocks.notify }));
vi.mock('../src/lib/proposal-scheduler.js', () => ({
  getAgentTasksQueue: vi.fn(),
  enqueueReviewTask: mocks.enqueueReviewTask,
  enqueueRunTask: mocks.enqueueRunTask,
  enqueueAddressReview: mocks.enqueueAddressReview,
}));
vi.mock('ioredis', () => ({ Redis: vi.fn() }));

import {
  pollReviewFeedback,
  recoverStuckReviews,
  registerPrStateSyncSchedule,
  syncMergedPullRequests,
  taskStatusForPrState,
} from '../src/lib/pr-state-sync.js';
import { getAgentTasksQueue } from '../src/lib/proposal-scheduler.js';

describe('registerPrStateSyncSchedule', () => {
  it('registers the repeatable job with the configured interval', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getAgentTasksQueue).mockReturnValue({ upsertJobScheduler } as never);

    await registerPrStateSyncSchedule();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'pr-state-sync',
      { every: 12_345 },
      { name: 'pr-state-sync', data: {} },
    );
  });
});

function awaitingTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    title: 'Add feature X',
    status: 'awaiting_review',
    prUrl: 'https://pr/1',
    branchName: 'lemniscate/t-1',
    repositoryId: 'r1',
    repository: {
      fullName: 'org/demo',
      defaultBranch: 'main',
      connection: { provider: 'github', baseUrl: null, accessTokenEnc: 'enc', userId: 'user-1' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the repo listing finds nothing, so legacy per-task tests exercise
  // the per-branch fallback path. Batching tests override this per case.
  mocks.listPullRequests.mockResolvedValue([]);
  mocks.listPrReviewComments.mockResolvedValue([]);
  // clearAllMocks wipes hoisted defaults — re-seed the ones used by recoverStuckReviews.
  mocks.taskEventCount.mockResolvedValue(0);
  mocks.taskEventFindMany.mockResolvedValue([]);
  mocks.taskEventFindFirst.mockResolvedValue(null);
  mocks.taskUpdate.mockResolvedValue({});
  mocks.enqueueReviewTask.mockResolvedValue(undefined);
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
    // The repo owner gets a pr_merged notification pointing at the PR.
    expect(mocks.notify).toHaveBeenCalledWith('user-1', 'pr_merged', {
      title: 'PR merged: Add feature X',
      body: 'org/demo — pull request merged on the git host',
      taskId: 't1',
      prUrl: 'https://pr/1',
    });
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
    expect(mocks.notify).toHaveBeenCalledWith(
      'user-1',
      'pr_closed',
      expect.objectContaining({ taskId: 't-closed' }),
    );
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

  it('queries awaiting_review and reviewing_code tasks that have a PR and branch, archived included', async () => {
    mocks.taskFindMany.mockResolvedValue([]);
    await syncMergedPullRequests();
    expect(mocks.taskFindMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['awaiting_review', 'reviewing_code'] },
        prUrl: { not: null },
        branchName: { not: null },
        repository: { connection: { disconnectedAt: null } },
      },
      include: { repository: { include: { connection: true } } },
    });
  });
});

describe('syncMergedPullRequests batching', () => {
  it('resolves all tasks of one repository with a single listPullRequests call', async () => {
    mocks.taskFindMany.mockResolvedValue([
      awaitingTask({ id: 't-a', branchName: 'lemniscate/t-a' }),
      awaitingTask({ id: 't-b', branchName: 'lemniscate/t-b' }),
    ]);
    mocks.listPullRequests.mockResolvedValue([
      { headBranch: 'lemniscate/t-a', baseBranch: 'main', state: 'merged' },
      { headBranch: 'lemniscate/t-b', baseBranch: 'main', state: 'open' },
    ]);

    await syncMergedPullRequests();

    expect(mocks.listPullRequests).toHaveBeenCalledTimes(1);
    expect(mocks.listPullRequests).toHaveBeenCalledWith(
      awaitingTask().repository.connection,
      'org/demo',
    );
    expect(mocks.pullRequestState).not.toHaveBeenCalled();
    expect(mocks.setTaskStatus).toHaveBeenCalledTimes(1);
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('t-a', 'done');
    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith('/tmp/test-workdirs/t-a', 't-a');
  });

  it('makes one list call per repository, not per task', async () => {
    mocks.taskFindMany.mockResolvedValue([
      awaitingTask({ id: 't-a', branchName: 'lemniscate/t-a' }),
      awaitingTask({
        id: 't-c',
        branchName: 'lemniscate/t-c',
        repositoryId: 'r2',
        repository: {
          fullName: 'org/other',
          defaultBranch: 'main',
          connection: { provider: 'github', baseUrl: null, accessTokenEnc: 'enc' },
        },
      }),
    ]);

    await syncMergedPullRequests();

    expect(mocks.listPullRequests).toHaveBeenCalledTimes(2);
    // Both branches are absent from the (empty) lists — per-branch fallback.
    expect(mocks.pullRequestState).toHaveBeenCalledTimes(2);
  });

  it('falls back to the per-branch check when the branch is absent from the list', async () => {
    mocks.taskFindMany.mockResolvedValue([awaitingTask()]);
    mocks.listPullRequests.mockResolvedValue([
      { headBranch: 'someone/else', baseBranch: 'main', state: 'merged' },
    ]);
    mocks.pullRequestState.mockResolvedValue('closed');

    await syncMergedPullRequests();

    expect(mocks.pullRequestState).toHaveBeenCalledTimes(1);
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('t1', 'closed');
  });

  it('falls back to per-branch checks for the whole repo when the list call fails', async () => {
    mocks.taskFindMany.mockResolvedValue([
      awaitingTask({ id: 't-a', branchName: 'lemniscate/t-a' }),
      awaitingTask({ id: 't-b', branchName: 'lemniscate/t-b' }),
    ]);
    mocks.listPullRequests.mockRejectedValue(new Error('github: HTTP 500'));
    mocks.pullRequestState.mockResolvedValue('merged');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await syncMergedPullRequests();

    expect(mocks.pullRequestState).toHaveBeenCalledTimes(2);
    expect(mocks.setTaskStatus).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('recoverStuckReviews', () => {
  it('re-enqueues the review when the last log line is a job error', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 't-stuck' }]);
    mocks.taskEventFindMany.mockResolvedValue([{ payload: { line: 'error: Request timed out' } }]);

    await recoverStuckReviews();

    expect(mocks.enqueueReviewTask).toHaveBeenCalledWith('t-stuck');
    expect(mocks.logEvent).toHaveBeenCalledWith(
      't-stuck',
      'recovery: re-enqueued PR review after a failed review job',
    );
  });

  it('leaves tasks alone when the review concluded without an error', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 't-waiting' }]);
    mocks.taskEventFindMany.mockResolvedValue([
      { payload: { line: 'approved by LLM, awaiting manual merge' } },
    ]);

    await recoverStuckReviews();

    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
  });

  it('stops re-enqueueing after the per-task recovery cap', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 't-flapping' }]);
    mocks.taskEventCount.mockResolvedValue(3);
    mocks.taskEventFindMany.mockResolvedValue([{ payload: { line: 'error: boom' } }]);

    await recoverStuckReviews();

    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
  });

  it('re-enqueues when "cleaned up workdir" log masks the error line', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 't-masked' }]);
    mocks.taskEventFindMany.mockResolvedValue([
      { createdAt: new Date('2026-07-29T18:18:27.722Z'), payload: { line: 'cleaned up workdir' } },
      { createdAt: new Date('2026-07-29T18:18:27.094Z'), payload: { line: 'error: Too many consecutive tool failures' } },
    ]);

    await recoverStuckReviews();

    expect(mocks.enqueueReviewTask).toHaveBeenCalledWith('t-masked');
  });

  it('recovers a stale review that died silently (no error line, no live job)', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    mocks.taskFindMany.mockResolvedValue([{ id: 't-silent', updatedAt: twoHoursAgo }]);
    mocks.taskEventFindMany.mockResolvedValue([
      { payload: { line: 'no valid .lemniscate-review.json from lemcore; caller should fall back if needed' } },
    ]);
    mocks.taskEventFindFirst.mockResolvedValue({ createdAt: twoHoursAgo });
    const getJobs = vi.fn().mockResolvedValue([]);
    vi.mocked(getAgentTasksQueue).mockReturnValue({ getJobs } as never);

    await recoverStuckReviews();

    expect(mocks.enqueueReviewTask).toHaveBeenCalledWith('t-silent');
  });

  it('skips a stale review while any job for the task is still in the queue', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    mocks.taskFindMany.mockResolvedValue([{ id: 't-gated', updatedAt: twoHoursAgo }]);
    mocks.taskEventFindMany.mockResolvedValue([{ payload: { line: 'some non-decisive line' } }]);
    mocks.taskEventFindFirst.mockResolvedValue({ createdAt: twoHoursAgo });
    const getJobs = vi.fn().mockResolvedValue([{ id: 'merge-gate-t-gated-0-0' }]);
    vi.mocked(getAgentTasksQueue).mockReturnValue({ getJobs } as never);

    await recoverStuckReviews();

    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
  });

  it('skips a review with recent activity without touching the queue', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 't-fresh', updatedAt: new Date() }]);
    mocks.taskEventFindMany.mockResolvedValue([
      { payload: { line: '⇄ model switch requested → k3 [Kimi-K3] — takes effect on the next LLM call' } },
    ]);
    mocks.taskEventFindFirst.mockResolvedValue({ createdAt: new Date() });
    const getJobs = vi.fn().mockResolvedValue([]);
    vi.mocked(getAgentTasksQueue).mockReturnValue({ getJobs } as never);

    await recoverStuckReviews();

    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(getJobs).not.toHaveBeenCalled();
  });

  it('treats a concluded review as finished even with an older error line in the window', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 't-concluded' }]);
    mocks.taskEventFindMany.mockResolvedValue([
      { payload: { line: 'approved by LLM, awaiting manual merge' } },
      { payload: { line: 'error: boom' } },
    ]);

    await recoverStuckReviews();

    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
  });

  it('recovers when the error line is newer than a concluded-review marker', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 't-rereview-died' }]);
    mocks.taskEventFindMany.mockResolvedValue([
      { payload: { line: 'error: Request timed out' } },
      { payload: { line: 'queued the merge gate — auto-merge once CI is green' } },
    ]);

    await recoverStuckReviews();

    expect(mocks.enqueueReviewTask).toHaveBeenCalledWith('t-rereview-died');
  });

  it('re-enqueues run-task for a task stuck in running after a dead run job', async () => {
    mocks.taskFindMany.mockResolvedValue([
      { id: 't-run-dead', status: 'running', repository: { autoReviewPr: true } },
    ]);
    mocks.taskEventFindMany.mockResolvedValue([
      { payload: { line: 'error: job stalled more than allowable limit' } },
    ]);

    await recoverStuckReviews();

    // The dead run's status is reset to 'queued' before re-enqueueing so the
    // atomic claim in runTask can flip it back to 'running' — 'running' is
    // deliberately not a claimable-from state (a live executor owns it).
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 't-run-dead' },
      data: { status: 'queued' },
    });
    expect(mocks.enqueueRunTask).toHaveBeenCalledWith('t-run-dead');
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      't-run-dead',
      'recovery: re-enqueued task run after a failed run job',
    );
  });

  it('recovers a stuck run even when the repo review toggle is off', async () => {
    mocks.taskFindMany.mockResolvedValue([
      { id: 't-run-no-review', status: 'running', repository: { autoReviewPr: false } },
    ]);
    mocks.taskEventFindMany.mockResolvedValue([{ payload: { line: 'error: boom' } }]);

    await recoverStuckReviews();

    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 't-run-no-review' },
      data: { status: 'queued' },
    });
    expect(mocks.enqueueRunTask).toHaveBeenCalledWith('t-run-no-review');
  });

  it('skips review recovery when the repo review toggle is off', async () => {
    mocks.taskFindMany.mockResolvedValue([
      { id: 't-review-off', status: 'awaiting_review', repository: { autoReviewPr: false } },
    ]);
    mocks.taskEventFindMany.mockResolvedValue([{ payload: { line: 'error: boom' } }]);

    await recoverStuckReviews();

    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.enqueueRunTask).not.toHaveBeenCalled();
  });

  it('shares the recovery budget across run and review recoveries', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 't-flapping', status: 'running' }]);
    mocks.taskEventCount.mockResolvedValue(3);
    mocks.taskEventFindMany.mockResolvedValue([{ payload: { line: 'error: boom' } }]);

    await recoverStuckReviews();

    expect(mocks.enqueueRunTask).not.toHaveBeenCalled();
  });
});

describe('pollReviewFeedback (webhook fallback)', () => {
  function feedbackTask(overrides: Record<string, unknown> = {}) {
    return awaitingTask({
      lastAddressedReviewId: null,
      repository: {
        fullName: 'org/demo',
        defaultBranch: 'main',
        autoAddressReview: true,
        connection: { provider: 'github', baseUrl: null, accessTokenEnc: 'enc', username: 'agent-bot' },
      },
      ...overrides,
    });
  }

  it('enqueues address-review for unseen human comments on opted-in repos', async () => {
    mocks.taskFindMany.mockResolvedValue([feedbackTask()]);
    mocks.listPrReviewComments.mockResolvedValue([
      { id: 'rc-1', body: 'first nit', author: 'human-reviewer' },
      { id: 'rc-2', body: 'handle the null case', author: 'human-reviewer' },
    ]);

    await pollReviewFeedback();

    expect(mocks.listPrReviewComments).toHaveBeenCalledWith(
      feedbackTask().repository.connection,
      { repoFullName: 'org/demo', headBranch: 'lemniscate/t-1', baseBranch: 'main' },
    );
    expect(mocks.enqueueAddressReview).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueAddressReview).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ id: 'rc-2' }),
    );
  });

  it('skips self-authored and already-addressed comments', async () => {
    mocks.taskFindMany.mockResolvedValue([feedbackTask({ lastAddressedReviewId: 'rc-5' })]);
    mocks.listPrReviewComments.mockResolvedValue([
      { id: 'rc-4', body: 'old feedback', author: 'human-reviewer' },
      { id: 'rc-6', body: 'agent talking to itself', author: 'Agent-Bot' },
    ]);

    await pollReviewFeedback();

    expect(mocks.enqueueAddressReview).not.toHaveBeenCalled();
  });

  it('does not call the provider when the repo flag is off', async () => {
    mocks.taskFindMany.mockResolvedValue([awaitingTask()]);

    await pollReviewFeedback();

    expect(mocks.listPrReviewComments).not.toHaveBeenCalled();
    expect(mocks.enqueueAddressReview).not.toHaveBeenCalled();
  });

  it('logs and skips a task whose provider call fails', async () => {
    mocks.taskFindMany.mockResolvedValue([feedbackTask()]);
    mocks.listPrReviewComments.mockRejectedValue(new Error('github: HTTP 500'));

    await expect(pollReviewFeedback()).resolves.toBeUndefined();

    expect(mocks.enqueueAddressReview).not.toHaveBeenCalled();
  });
});
