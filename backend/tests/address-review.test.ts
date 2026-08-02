import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tests for the address-review job (lib/address-review.ts): the guards that
// make a redelivered/self-authored/flag-off comment a no-op, and the
// success path that reuses the review loop's fix machinery and persists the
// last-addressed marker. prisma, the agent runtime/git plumbing, the fix
// executor, and notifications are all mocked — no DB, git, or LLM.

const mocks = vi.hoisted(() => ({
  loadTaskWithRepo: vi.fn(),
  prepareAgentRuntime: vi.fn(),
  tokenSplit: vi.fn().mockReturnValue({ promptTokens: 0, completionTokens: 0 }),
  checkoutTaskBranch: vi.fn().mockResolvedValue(undefined),
  cleanupWorkdir: vi.fn().mockResolvedValue(undefined),
  git: vi.fn().mockResolvedValue(''),
  logEvent: vi.fn().mockResolvedValue(undefined),
  persistTokenUsage: vi.fn().mockResolvedValue(undefined),
  recordJobFailure: vi.fn().mockResolvedValue('error'),
  applyReviewFixes: vi.fn().mockResolvedValue(undefined),
  notify: vi.fn().mockResolvedValue(undefined),
  setTaskStatus: vi.fn().mockResolvedValue(undefined),
  taskUpdate: vi.fn().mockResolvedValue({}),
  taskFindUnique: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  config: { AGENT_WORKDIR: '/tmp/address-review-test-workdirs', AGENT_EXECUTOR: 'hermes' },
}));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    task: { update: mocks.taskUpdate, findUnique: mocks.taskFindUnique },
  },
}));
vi.mock('../src/lib/agent-runtime.js', () => ({
  loadTaskWithRepo: mocks.loadTaskWithRepo,
  prepareAgentRuntime: mocks.prepareAgentRuntime,
  tokenSplit: mocks.tokenSplit,
}));
vi.mock('../src/lib/agent-git.js', () => ({
  checkoutTaskBranch: mocks.checkoutTaskBranch,
  cleanupWorkdir: mocks.cleanupWorkdir,
  git: mocks.git,
  logEvent: mocks.logEvent,
  persistTokenUsage: mocks.persistTokenUsage,
  recordJobFailure: mocks.recordJobFailure,
}));
vi.mock('../src/lib/agent-review.js', () => ({
  applyReviewFixes: mocks.applyReviewFixes,
}));
vi.mock('../src/lib/notifications.js', () => ({ notify: mocks.notify }));
vi.mock('../src/lib/task-events.js', () => ({ setTaskStatus: mocks.setTaskStatus }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { addressReviewTask } from '../src/lib/address-review.js';

const TASK_ID = 'task-1';
const COMMENT = { id: 'rc-99', body: 'please handle the null case', author: 'human-reviewer' };

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: 'Add feature X',
    prompt: null,
    status: 'awaiting_review',
    branchName: 'lemniscate/t-1',
    prUrl: 'https://github.com/org/demo/pull/42',
    llmTokensUsed: 0,
    lastAddressedReviewId: null,
    repository: {
      fullName: 'org/demo',
      defaultBranch: 'main',
      autoAddressReview: true,
      reviewLlmConfigId: null,
      cloneUrl: 'https://github.com/org/demo.git',
      connection: { userId: 'user-1', username: 'agent-bot' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskFindUnique.mockResolvedValue({ status: 'awaiting_review' });
  mocks.prepareAgentRuntime.mockResolvedValue({
    cloneUrl: 'https://github.com/org/demo.git',
    gitAuth: { username: 'x-access-token', token: 'tok' },
    rt: { usedTokens: 0, cfg: {} },
  });
});

describe('addressReviewTask — guards', () => {
  it('does nothing when the task does not exist', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(null);
    await addressReviewTask(TASK_ID, COMMENT);
    expect(mocks.applyReviewFixes).not.toHaveBeenCalled();
  });

  it('does nothing when autoAddressReview is off (default: do not intervene)', async () => {
    const t = task();
    t.repository.autoAddressReview = false;
    mocks.loadTaskWithRepo.mockResolvedValue(t);
    await addressReviewTask(TASK_ID, COMMENT);
    expect(mocks.applyReviewFixes).not.toHaveBeenCalled();
    expect(mocks.prepareAgentRuntime).not.toHaveBeenCalled();
  });

  it('does nothing for a comment the task already addressed', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(task({ lastAddressedReviewId: 'rc-99' }));
    await addressReviewTask(TASK_ID, COMMENT);
    expect(mocks.applyReviewFixes).not.toHaveBeenCalled();
  });

  it('does nothing for a comment authored by the agent itself', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(task());
    await addressReviewTask(TASK_ID, { ...COMMENT, author: 'Agent-Bot' });
    expect(mocks.applyReviewFixes).not.toHaveBeenCalled();
  });

  it('does nothing when the task left the review window', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(task({ status: 'done' }));
    await addressReviewTask(TASK_ID, COMMENT);
    expect(mocks.applyReviewFixes).not.toHaveBeenCalled();
  });
});

describe('addressReviewTask — success path', () => {
  it('runs the fix, persists the marker, notifies, and keeps the workdir', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(task());
    await addressReviewTask(TASK_ID, COMMENT);

    // The review-feedback loop reuses the review loop's fix executor with
    // the human comment shaped into a changes_requested review.
    expect(mocks.applyReviewFixes).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      expect.anything(),
      expect.objectContaining({
        verdict: 'changes_requested',
        issues: [expect.objectContaining({ comment: 'please handle the null case' })],
      }),
      'lemniscate/t-1',
      expect.stringContaining(TASK_ID),
      expect.any(String),
      expect.any(Array),
      expect.anything(),
    );
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: { lastAddressedReviewId: 'rc-99' },
    });
    // The fix commit was pushed — CI re-runs on the git host, so the task
    // waits for CI checks (a ci_status webhook / merge-gate re-check flips it
    // back to awaiting_review).
    expect(mocks.setTaskStatus).toHaveBeenCalledWith(TASK_ID, 'waiting_ci');
    expect(mocks.notify).toHaveBeenCalledWith(
      'user-1',
      'review_addressed',
      expect.objectContaining({ taskId: TASK_ID }),
    );
    // Still awaiting review: the kept run workdir is NOT cleaned up here.
    expect(mocks.cleanupWorkdir).not.toHaveBeenCalled();
  });

  it('cleans the workdir up when the task reached a terminal state mid-job', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(task());
    mocks.taskFindUnique.mockResolvedValue({ status: 'done' });
    await addressReviewTask(TASK_ID, COMMENT);
    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith(
      expect.stringContaining(TASK_ID),
      TASK_ID,
    );
  });

  it('records the failure and rethrows so BullMQ retries', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(task());
    mocks.applyReviewFixes.mockRejectedValue(new Error('LLM endpoint down'));
    await expect(addressReviewTask(TASK_ID, COMMENT)).rejects.toThrow('LLM endpoint down');
    expect(mocks.recordJobFailure).toHaveBeenCalledWith(
      'address-review',
      TASK_ID,
      expect.any(Error),
      expect.any(Array),
    );
    // The marker is only written on success — a retry addresses it again.
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });
});
