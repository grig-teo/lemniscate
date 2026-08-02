import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(),
  persistTokenUsage: vi.fn(),
  enqueueMergeGate: vi.fn(),
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

describe('continueOrFinishReview (single review, single fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistTokenUsage.mockResolvedValue(undefined);
    mocks.enqueueMergeGate.mockResolvedValue(undefined);
    mocks.setTaskStatus.mockResolvedValue(undefined);
    mocks.logEvent.mockResolvedValue(undefined);
  });

  it('on changes_requested: applies ONE fix, then finishes — never re-reviews', async () => {
    const fix = vi.fn().mockResolvedValue(undefined);
    await continueOrFinishReview(
      task(),
      rt(),
      { verdict: 'changes_requested', summary: 'fix me', issues: [] },
      fix,
    );

    // Exactly one fix iteration, no matter the verdict.
    expect(fix).toHaveBeenCalledOnce();
    // Usage is persisted after the fix runs.
    expect(mocks.persistTokenUsage).toHaveBeenCalledWith(
      'task-1',
      10,
      { promptTokens: 1, completionTokens: 2 },
    );
    // The fix is the last word: the task waits for CI on the pushed fix.
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'waiting_ci');
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('on approve: skips the fix and goes straight to the merge gate', async () => {
    const fix = vi.fn();
    await continueOrFinishReview(
      task(true),
      rt(),
      { verdict: 'approve', summary: 'lgtm', issues: [] },
      fix,
    );

    expect(fix).not.toHaveBeenCalled();
    expect(mocks.persistTokenUsage).not.toHaveBeenCalled();
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'waiting_ci');
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('after a fix on changes_requested with autoMerge off: finishes for manual review', async () => {
    const fix = vi.fn().mockResolvedValue(undefined);
    await continueOrFinishReview(
      task(false),
      rt(),
      { verdict: 'changes_requested', summary: 'still bad', issues: [] },
      fix,
    );

    expect(fix).toHaveBeenCalledOnce();
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'waiting_ci');
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      'changes still requested, awaiting manual review',
    );
  });
});

describe('finishReview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not enqueue merge gate when autoMergePr is off', async () => {
    await finishReview(task(false), { verdict: 'approve', summary: 'ok', issues: [] });
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'waiting_ci');
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });
});
