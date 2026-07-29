import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(),
  persistTokenUsage: vi.fn(),
  enqueueMergeGate: vi.fn(),
  enqueueReviewTask: vi.fn(),
  setTaskStatus: vi.fn(),
  tokenSplit: vi.fn(() => ({ promptTokens: 1, completionTokens: 2 })),
}));

vi.mock('../src/lib/agent-git.js', () => ({
  logEvent: mocks.logEvent,
  persistTokenUsage: mocks.persistTokenUsage,
}));
vi.mock('../src/lib/agent-runtime.js', () => ({
  tokenSplit: mocks.tokenSplit,
}));
vi.mock('../src/lib/proposal-scheduler.js', () => ({
  enqueueMergeGate: mocks.enqueueMergeGate,
  enqueueReviewTask: mocks.enqueueReviewTask,
}));
vi.mock('../src/lib/task-events.js', () => ({
  setTaskStatus: mocks.setTaskStatus,
}));

import { continueOrFinishReview, finishReview } from '../src/lib/review-finish.js';

function task(autoMergePr = true) {
  return {
    id: 'task-1',
    repository: { autoMergePr },
  } as never;
}

function rt() {
  return { usedTokens: 10, usedPromptTokens: 4, usedCompletionTokens: 6 } as never;
}

describe('continueOrFinishReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistTokenUsage.mockResolvedValue(undefined);
    mocks.enqueueReviewTask.mockResolvedValue(undefined);
    mocks.enqueueMergeGate.mockResolvedValue(undefined);
    mocks.setTaskStatus.mockResolvedValue(undefined);
    mocks.logEvent.mockResolvedValue(undefined);
  });

  it('on changes_requested: runs fix, persists usage, and enqueues re-review', async () => {
    const fix = vi.fn().mockResolvedValue(undefined);
    await continueOrFinishReview(
      task(),
      rt(),
      { verdict: 'changes_requested', summary: 'fix me', issues: [] },
      0,
      fix,
    );

    expect(fix).toHaveBeenCalledOnce();
    expect(mocks.persistTokenUsage).toHaveBeenCalledWith(
      'task-1',
      10,
      { promptTokens: 1, completionTokens: 2 },
    );
    expect(mocks.enqueueReviewTask).toHaveBeenCalledWith('task-1', 1);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      'queued re-review of the updated pull request',
    );
    expect(mocks.setTaskStatus).not.toHaveBeenCalled();
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });

  it('on approve: flips to awaiting_review and queues the merge gate', async () => {
    const fix = vi.fn();
    await continueOrFinishReview(
      task(true),
      rt(),
      { verdict: 'approve', summary: 'lgtm', issues: [] },
      0,
      fix,
    );

    expect(fix).not.toHaveBeenCalled();
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('after the fix attempt cap: finishes without another re-review', async () => {
    const fix = vi.fn();
    await continueOrFinishReview(
      task(false),
      rt(),
      { verdict: 'changes_requested', summary: 'still bad', issues: [] },
      3,
      fix,
    );

    expect(fix).not.toHaveBeenCalled();
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });
});

describe('finishReview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not enqueue merge gate when autoMergePr is off', async () => {
    await finishReview(task(false), { verdict: 'approve', summary: 'ok', issues: [] });
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });
});
