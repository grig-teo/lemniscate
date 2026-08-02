import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Task-level locking tests for the review-pr job (agent-review.ts): verdict
// parsing (real pr-review/llm-json parsers), fix-iteration chaining with the
// attempt cap, the merge-gate handoff, and the record-then-rethrow failure
// path BullMQ relies on for retries. Prisma, git, the queue, and the hermes
// runner are mocked; the hermes verdict file is a real file in a tmp workdir
// so read-then-delete behavior is pinned too.

const mocks = vi.hoisted(() => ({
  config: {
    AGENT_EXECUTOR: 'internal' as string,
    AGENT_WORKDIR: '/tmp/test-workdirs-review',
    AGENT_HERMES_TIMEOUT_MINUTES: 45,
  },
  applyChanges: vi.fn(),
  checkoutTaskBranch: vi.fn(),
  cleanupWorkdir: vi.fn(),
  commitAndPush: vi.fn(),
  hasDirtyWorkdir: vi.fn(),
  hasMeaningfulChanges: vi.fn(),
  logEvent: vi.fn(),
  persistTokenUsage: vi.fn(),
  recordJobFailure: vi.fn(),
  buildSkillsSection: vi.fn(),
  requestChanges: vi.fn(),
  llmCall: vi.fn(),
  loadTaskWithRepo: vi.fn(),
  prepareAgentRuntime: vi.fn(),
  runHermesTask: vi.fn(),
  enqueueMergeGate: vi.fn(),
  enqueueReviewTask: vi.fn(),
  getPullRequestDiff: vi.fn(),
  buildRepoContext: vi.fn(),
  loadAgentsMdTemplate: vi.fn(),
  loadTaskSkills: vi.fn(),
  setTaskStatus: vi.fn(),
  prismaTaskEventCount: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() },
}));

vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/lib/logger.js', () => ({
  logger: mocks.logger,
  createLogger: vi.fn(() => mocks.logger),
}));
vi.mock('../src/lib/agent-git.js', () => ({
  applyChanges: mocks.applyChanges,
  checkoutTaskBranch: mocks.checkoutTaskBranch,
  cleanupWorkdir: mocks.cleanupWorkdir,
  commitAndPush: mocks.commitAndPush,
  hasDirtyWorkdir: mocks.hasDirtyWorkdir,
  logEvent: mocks.logEvent,
  persistTokenUsage: mocks.persistTokenUsage,
  recordJobFailure: mocks.recordJobFailure,
}));
vi.mock('../src/lib/workdir-changes.js', () => ({
  hasMeaningfulChanges: mocks.hasMeaningfulChanges,
}));
vi.mock('../src/lib/agent-prompts.js', () => ({
  buildSkillsSection: mocks.buildSkillsSection,
  requestChanges: mocks.requestChanges,
}));
vi.mock('../src/lib/agent-runtime.js', () => ({
  llmCall: mocks.llmCall,
  loadTaskWithRepo: mocks.loadTaskWithRepo,
  prepareAgentRuntime: mocks.prepareAgentRuntime,
  tokenSplit: (rt: { usedPromptTokens?: number; usedCompletionTokens?: number }) => ({
    promptTokens: rt.usedPromptTokens ?? 0,
    completionTokens: rt.usedCompletionTokens ?? 0,
  }),
}));
vi.mock('../src/lib/hermes-runner.js', () => ({ runHermesTask: mocks.runHermesTask }));
vi.mock('../src/lib/proposal-scheduler.js', () => ({
  enqueueMergeGate: mocks.enqueueMergeGate,
  enqueueReviewTask: mocks.enqueueReviewTask,
}));
vi.mock('../src/lib/pull-requests.js', () => ({ getPullRequestDiff: mocks.getPullRequestDiff }));
vi.mock('../src/lib/repo-context.js', () => ({ buildRepoContext: mocks.buildRepoContext }));
vi.mock('../src/lib/task-skills.js', () => ({
  loadAgentsMdTemplate: mocks.loadAgentsMdTemplate,
  loadTaskSkills: mocks.loadTaskSkills,
}));
vi.mock('../src/lib/task-events.js', () => ({ setTaskStatus: mocks.setTaskStatus }));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { taskEvent: { count: mocks.prismaTaskEventCount } },
}));

// pr-review.js (parsePrReview, prompt builders) is intentionally NOT mocked:
// verdict parsing is the behavior under test.
import { HERMES_REVIEW_FILENAME } from '../src/lib/pr-review.js';
import { reviewTask } from '../src/lib/agent-review.js';

const BRANCH = 'lemniscate/feature-x';

function stubTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Add feature X',
    prompt: 'Implement feature X',
    status: 'awaiting_review',
    branchName: BRANCH,
    llmTokensUsed: 0,
    repository: {
      fullName: 'acme/widgets',
      defaultBranch: 'main',
      autoReviewPr: true,
      autoMergePr: true,
      reviewLlmConfigId: null,
      connection: {},
    },
    ...overrides,
  };
}

function stubRuntime() {
  return {
    cfg: {
      baseUrl: 'https://llm.example/v1',
      model: 'model-x',
      contextWindow: 128_000,
      systemPromptExtra: null,
    },
    apiKey: 'sk-test',
    usedTokens: 0,
  };
}

function reviewJson(verdict: 'approve' | 'changes_requested', issues: unknown[] = []) {
  return JSON.stringify({ verdict, summary: `${verdict} summary`, issues });
}

function workdirFor(attempt: number) {
  return path.join(mocks.config.AGENT_WORKDIR, `review-task-1-${attempt}`);
}

// Simulates the hermes CLI leaving (or not leaving) a verdict file behind.
function hermesWritesReviewFile(content: string | null) {
  return async (opts: { workdir: string }) => {
    if (content === null) return;
    await fs.mkdir(opts.workdir, { recursive: true });
    await fs.writeFile(path.join(opts.workdir, HERMES_REVIEW_FILENAME), content);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.AGENT_EXECUTOR = 'internal';
  mocks.loadTaskWithRepo.mockResolvedValue(stubTask());
  mocks.prepareAgentRuntime.mockResolvedValue({
    cloneUrl: 'https://clone',
    gitAuth: { headers: {} },
    rt: stubRuntime(),
  });
  mocks.getPullRequestDiff.mockResolvedValue('diff --git a/x b/x');
  mocks.llmCall.mockResolvedValue(reviewJson('approve'));
  mocks.requestChanges.mockResolvedValue({
    summary: 'fix the issues',
    changes: [{ path: 'src/a.ts', action: 'modify', content: 'fixed' }],
  });
  mocks.buildRepoContext.mockResolvedValue({ text: 'repo context' });
  mocks.buildSkillsSection.mockReturnValue('');
  mocks.loadAgentsMdTemplate.mockResolvedValue(null);
  mocks.loadTaskSkills.mockResolvedValue([]);
  mocks.applyChanges.mockResolvedValue(1);
  mocks.hasMeaningfulChanges.mockResolvedValue(true);
  mocks.checkoutTaskBranch.mockResolvedValue(undefined);
  mocks.commitAndPush.mockResolvedValue(undefined);
  mocks.enqueueMergeGate.mockResolvedValue(undefined);
  mocks.enqueueReviewTask.mockResolvedValue(undefined);
  mocks.persistTokenUsage.mockResolvedValue(undefined);
  mocks.cleanupWorkdir.mockResolvedValue(undefined);
  mocks.logEvent.mockResolvedValue(undefined);
  mocks.recordJobFailure.mockResolvedValue('recorded failure');
  mocks.runHermesTask.mockResolvedValue(undefined);
  mocks.setTaskStatus.mockResolvedValue(undefined);
  mocks.prismaTaskEventCount.mockResolvedValue(0);
});

afterEach(async () => {
  await fs.rm(mocks.config.AGENT_WORKDIR, { recursive: true, force: true });
});

// Entry guards: the job must no-op (and never touch the LLM or the queue)
// for tasks that are gone, already reviewed, opted out, or branchless.
describe('reviewTask entry guards', () => {
  it('logs an error and returns when the task does not exist', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reviewTask('task-1');
    expect(mocks.logger.error).toHaveBeenCalledWith(
      { taskId: 'task-1' },
      'review-pr: task not found',
    );
    expect(mocks.llmCall).not.toHaveBeenCalled();
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });

  it('does nothing when the task is no longer awaiting review', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(stubTask({ status: 'done' }));
    await reviewTask('task-1');
    expect(mocks.llmCall).not.toHaveBeenCalled();
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });

  it('does nothing when the repository has auto-review off', async () => {
    const task = stubTask();
    task.repository.autoReviewPr = false;
    mocks.loadTaskWithRepo.mockResolvedValue(task);
    await reviewTask('task-1');
    expect(mocks.llmCall).not.toHaveBeenCalled();
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });

  it('logs and returns when the task has no branch', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(stubTask({ branchName: null }));
    await reviewTask('task-1');
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('no branch'),
    );
    expect(mocks.llmCall).not.toHaveBeenCalled();
  });
});

describe('reviewTask on the internal executor', () => {
  it('sets reviewing_code at the start and waiting_ci when the review finishes', async () => {
    await reviewTask('task-1');
    // Status set to reviewing_code at the start of execution.
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'reviewing_code');
    // finishReview parks the task in waiting_ci: CI re-runs on the pushed
    // code, and a ci_status webhook / merge-gate re-check flips it back to
    // awaiting_review.
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'waiting_ci');
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('on changes_requested: applies ONE fix, finishes, and never re-reviews', async () => {
    mocks.llmCall.mockResolvedValue(
      reviewJson('changes_requested', [{ path: 'src/a.ts', comment: 'fix' }]),
    );
    await reviewTask('task-1', 0);
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'reviewing_code');
    // Single review pass always finishes — the task waits for CI on the fix.
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'waiting_ci');
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('hands an approved PR on an auto-merge repo to the merge gate', async () => {
    await reviewTask('task-1');
    expect(mocks.enqueueMergeGate).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
  });

  it('stops after approval when auto-merge is off (manual merge)', async () => {
    const task = stubTask();
    task.repository.autoMergePr = false;
    mocks.loadTaskWithRepo.mockResolvedValue(task);
    await reviewTask('task-1');
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('approved by LLM, awaiting manual merge'),
    );
  });

  it('applies fixes on the SAME branch once, then hands the PR to the merge gate', async () => {
    mocks.llmCall.mockResolvedValue(
      reviewJson('changes_requested', [{ path: 'src/a.ts', comment: 'null check missing' }]),
    );
    await reviewTask('task-1', 1);

    expect(mocks.checkoutTaskBranch).toHaveBeenCalledWith(
      workdirFor(1),
      'https://clone',
      'main',
      BRANCH,
      [],
      { headers: {} },
    );
    expect(mocks.applyChanges).toHaveBeenCalledTimes(1);
    expect(mocks.commitAndPush).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      expect.anything(),
      workdirFor(1),
      'fix the issues',
      ['push', 'origin', BRANCH],
      [],
      { headers: {} },
    );
    // One fix, then finish — no re-review, straight to the merge gate.
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('skips the push when the LLM produces no fix changes, but still finishes', async () => {
    mocks.llmCall.mockResolvedValue(
      reviewJson('changes_requested', [{ path: 'src/a.ts', comment: 'fix' }]),
    );
    mocks.applyChanges.mockResolvedValue(0);
    await reviewTask('task-1');
    expect(mocks.commitAndPush).not.toHaveBeenCalled();
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('truncates an oversized diff before sending it to the LLM', async () => {
    mocks.getPullRequestDiff.mockResolvedValue(`diff ${'x'.repeat(40_000)}`);
    await reviewTask('task-1');
    const messages = mocks.llmCall.mock.calls[0]?.[1] as { content: string }[];
    const sent = messages.map((m) => m.content).join('\n');
    expect(sent).toMatch(/… \[truncated/);
    expect(sent).not.toContain('x'.repeat(40_000));
  });
});

// Verdict parsing (real parsePrReview) and the failure contract: anything
// thrown inside the job is recorded AND rethrown so BullMQ retries — never
// swallowed, never silently converted to a merge.
describe('reviewTask verdict parsing and failure path', () => {
  it('parses an approve verdict out of surrounding LLM prose', async () => {
    mocks.llmCall.mockResolvedValue(
      `Here is my review:\n${reviewJson('approve')}\nHope this helps!`,
    );
    await reviewTask('task-1');
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('LLM review: approve'),
    );
  });

  it('treats an unparseable verdict as a retryable failure, not an approval', async () => {
    mocks.llmCall.mockResolvedValue('the diff looks fine to me, ship it');
    await expect(reviewTask('task-1')).rejects.toThrow();
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.recordJobFailure).toHaveBeenCalledWith(
      'review-pr',
      'task-1',
      expect.any(Error),
      [],
    );
  });

  it('rethrows LLM errors for BullMQ retry and still cleans up the workdir', async () => {
    const boom = new Error('LLM endpoint exploded');
    mocks.llmCall.mockRejectedValue(boom);
    await expect(reviewTask('task-1')).rejects.toBe(boom);
    expect(mocks.recordJobFailure).toHaveBeenCalledWith('review-pr', 'task-1', boom, []);
    expect(mocks.persistTokenUsage).toHaveBeenCalledWith('task-1', 0, undefined);
    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith(workdirFor(0), 'task-1');
  });
});

// Rate-limit failures (HTTP 429, provider quota windows of hours) must NOT
// burn BullMQ's 60s-backoff attempts: the job records the failure, parks the
// task back in awaiting_review, and re-enqueues itself past the reset
// window. Bounded — an endlessly quota-dead config eventually rethrows.
describe('reviewTask rate-limit deferral', () => {
  const quotaError = () =>
    new Error(
      'LLM endpoint returned HTTP 429: {"error":{"message":"Usage limit reached for 5 hour. Your limit will reset at 2026-07-27 19:07:44"}}',
    );

  it('defers a rate-limited review instead of rethrowing', async () => {
    mocks.llmCall.mockRejectedValue(quotaError());
    await expect(reviewTask('task-1')).resolves.toBeUndefined();
    expect(mocks.recordJobFailure).toHaveBeenCalledWith(
      'review-pr',
      'task-1',
      expect.any(Error),
      [],
    );
    // Task is parked (not left in reviewing_code), the pause line is the
    // last log, and a delayed review job takes over.
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('review paused: LLM rate limit reached'),
    );
    expect(mocks.enqueueReviewTask).toHaveBeenCalledWith(
      'task-1',
      0,
      expect.any(Number),
      1,
    );
    const delay = mocks.enqueueReviewTask.mock.calls[0][2] as number;
    expect(delay).toBeGreaterThanOrEqual(10 * 60_000);
    expect(delay).toBeLessThanOrEqual(6 * 60 * 60_000);
    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith(workdirFor(0), 'task-1');
  });

  it('sequences defer jobIds so repeated pauses are never deduped away', async () => {
    mocks.prismaTaskEventCount.mockResolvedValue(3);
    mocks.llmCall.mockRejectedValue(quotaError());
    await reviewTask('task-1');
    expect(mocks.enqueueReviewTask).toHaveBeenCalledWith(
      'task-1',
      0,
      expect.any(Number),
      4,
    );
  });

  it('rethrows once the defer budget is exhausted', async () => {
    mocks.prismaTaskEventCount.mockResolvedValue(12);
    const boom = quotaError();
    mocks.llmCall.mockRejectedValue(boom);
    await expect(reviewTask('task-1')).rejects.toBe(boom);
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
  });

  it('does not defer non-rate-limit failures', async () => {
    const boom = new Error('git push failed');
    mocks.llmCall.mockRejectedValue(boom);
    await expect(reviewTask('task-1')).rejects.toBe(boom);
    expect(mocks.logEvent).not.toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('review paused'),
    );
  });
});

describe('reviewTask on the hermes executor', () => {
  beforeEach(() => {
    mocks.config.AGENT_EXECUTOR = 'hermes';
  });

  it('parses the verdict from the hermes review file and ALWAYS deletes the file', async () => {
    mocks.runHermesTask.mockImplementation(hermesWritesReviewFile(reviewJson('approve')));
    await reviewTask('task-1');

    expect(mocks.runHermesTask).toHaveBeenCalledTimes(1);
    const opts = mocks.runHermesTask.mock.calls[0]?.[0];
    expect(opts.taskId).toBe('task-1');
    expect(opts.timeoutMs).toBe(45 * 60_000);
    expect(opts.prompt).toContain('Add feature X');
    // Leftover verdict files would dirty the workdir and ride into the fix commit.
    expect(existsSync(path.join(workdirFor(0), HERMES_REVIEW_FILENAME))).toBe(false);
    expect(mocks.llmCall).not.toHaveBeenCalled(); // no fallback needed
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('falls back to a direct LLM review when hermes leaves no verdict file', async () => {
    mocks.runHermesTask.mockImplementation(hermesWritesReviewFile(null));
    await reviewTask('task-1');
    expect(mocks.llmCall).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('falling back to a direct LLM review'),
    );
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('falls back to a direct LLM review when the verdict file is invalid JSON', async () => {
    mocks.runHermesTask.mockImplementation(hermesWritesReviewFile('{"verdict": "lgtm"}'));
    await reviewTask('task-1');
    expect(mocks.llmCall).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('runs ONE hermes fix iteration on the same checkout, then hands off to the merge gate', async () => {
    mocks.runHermesTask
      .mockImplementationOnce(
        hermesWritesReviewFile(
          reviewJson('changes_requested', [{ path: 'src/a.ts', comment: 'add tests' }]),
        ),
      )
      .mockImplementationOnce(async () => {}); // fix iteration leaves edits on disk
    await reviewTask('task-1', 0);

    expect(mocks.runHermesTask).toHaveBeenCalledTimes(2);
    const fixOpts = mocks.runHermesTask.mock.calls[1]?.[0];
    expect(fixOpts.workdir).toBe(workdirFor(0)); // same checkout as the review
    expect(fixOpts.prompt).toContain('add tests');
    expect(mocks.commitAndPush).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      expect.anything(),
      workdirFor(0),
      'address review issues',
      ['push', 'origin', BRANCH],
      [],
      { headers: {} },
    );
    // One fix, then finish — no re-review, straight to the merge gate.
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('skips the push when hermes leaves a clean workdir, but still finishes', async () => {
    mocks.runHermesTask
      .mockImplementationOnce(
        hermesWritesReviewFile(
          reviewJson('changes_requested', [{ path: 'src/a.ts', comment: 'fix' }]),
        ),
      )
      .mockImplementationOnce(async () => {});
    mocks.hasMeaningfulChanges.mockResolvedValue(false);
    await reviewTask('task-1');
    expect(mocks.commitAndPush).not.toHaveBeenCalled();
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('rethrows hermes failures for BullMQ retry', async () => {
    const boom = new Error('hermes crashed');
    mocks.runHermesTask.mockRejectedValue(boom);
    await expect(reviewTask('task-1')).rejects.toBe(boom);
    expect(mocks.recordJobFailure).toHaveBeenCalledWith('review-pr', 'task-1', boom, []);
    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith(workdirFor(0), 'task-1');
  });
});
