import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Review-pr job tests (agent-review.ts): the lemcore review loop drives the
// verdict parsing and fix iteration, so these tests pin the job-level
// behavior — status flips, the merge-gate handoff, the record-then-rethrow
// failure path BullMQ relies on for retries, and the rate-limit defer that
// parks the task instead of burning retry attempts. Prisma, git, the queue,
// and the lemcore agent loop are mocked; the real review-finish /
// review-defer helpers run so the finish path is locked end-to-end.

const mocks = vi.hoisted(() => ({
  prisma: {
    task: { findUnique: vi.fn(), update: vi.fn() },
    taskEvent: { create: vi.fn(), count: vi.fn() },
  },
  runLemcoreLoop: vi.fn(),
  loadTranscript: vi.fn(() => null),
  llmCall: vi.fn(),
  cloneRepository: vi.fn(),
  checkoutTaskBranch: vi.fn(),
  cleanupWorkdir: vi.fn(),
  applyChanges: vi.fn(),
  commitAndPush: vi.fn(),
  computeDiffStat: vi.fn(),
  hasMeaningfulChanges: vi.fn(),
  hasDirtyWorkdir: vi.fn(),
  recordJobFailure: vi.fn(),
  loadAgentsMdTemplate: vi.fn(),
  collectSecretValues: vi.fn(),
  getPullRequestDiff: vi.fn(),
  enqueueReviewTask: vi.fn(),
  enqueueMergeGate: vi.fn(),
  setTaskStatus: vi.fn(),
  taskUpdate: vi.fn(),
  prepareAgentRuntime: vi.fn(),
  config: {
    AGENT_WORKDIR: '/tmp/test-workdirs-review',
    INTERNAL_LLM_TIMEOUT_MS: 45 * 60_000,
  },
}));

vi.mock('../src/lib/prisma.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/plugins/auth.js', () => ({
  isAuthDisabled: () => false,
  requireAuth: vi.fn(),
  authenticatedUserId: vi.fn(),
}));
vi.mock('../src/lib/agent-git.js', () => ({
  cloneRepository: mocks.cloneRepository,
  checkoutTaskBranch: mocks.checkoutTaskBranch,
  cleanupWorkdir: mocks.cleanupWorkdir,
  applyChanges: mocks.applyChanges,
  commitAndPush: mocks.commitAndPush,
  computeDiffStat: mocks.computeDiffStat,
  hasMeaningfulChanges: mocks.hasMeaningfulChanges,
  hasDirtyWorkdir: mocks.hasDirtyWorkdir,
  recordJobFailure: mocks.recordJobFailure,
  persistTokenUsage: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock('../src/lib/workdir-changes.js', () => ({
  hasMeaningfulChanges: mocks.hasMeaningfulChanges,
}));
vi.mock('../src/lib/repo-context.js', () => ({ buildRepoContext: vi.fn() }));
vi.mock('../src/lib/agent-prompts.js', () => ({
  loadAgentsMdTemplate: mocks.loadAgentsMdTemplate,
  collectSecretValues: mocks.collectSecretValues,
}));
vi.mock('../src/lib/pull-requests.js', () => ({
  getPullRequestDiff: mocks.getPullRequestDiff,
  upsertPullRequest: vi.fn(),
}));
vi.mock('../src/lib/proposal-scheduler.js', () => ({
  enqueueReviewTask: mocks.enqueueReviewTask,
  enqueueMergeGate: mocks.enqueueMergeGate,
}));
vi.mock('../src/lib/task-events.js', () => ({
  setTaskStatus: mocks.setTaskStatus,
  taskUpdate: mocks.taskUpdate,
}));
vi.mock('../src/lib/lemcore/loop.js', () => ({
  runLemcoreLoop: mocks.runLemcoreLoop,
  loadTranscript: (...args: unknown[]) => mocks.loadTranscript(...args),
}));
vi.mock('../src/lib/agent-runtime.js', () => ({
  loadTaskWithRepo: vi.fn(async (taskId: string) => {
    const task = await mocks.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return null;
    mocks.taskUpdate.mockImplementation(async (args: { where: { id: string }; data: object }) => {
      Object.assign(task, args.data);
      return task;
    });
    return task;
  }),
  prepareAgentRuntime: mocks.prepareAgentRuntime,
  llmCall: mocks.llmCall,
  tokenSplit: (rt: { usedTokens: number }) => ({ total: rt.usedTokens }),
}));

import { reviewTask } from '../src/lib/agent-review.js';

const BRANCH = 'lemniscate/task-1';

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Fix the bug',
    prompt: 'Fix it',
    status: 'awaiting_review',
    branchName: BRANCH,
    llmTokensUsed: 0,
    llmConfig: {
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-test',
      model: 'model-x',
      contextWindow: 128_000,
    },
    llmConfigId: 'cfg-1',
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

function reviewJson(verdict: 'approve' | 'changes_requested', comment = 'fix the issues') {
  return JSON.stringify({
    verdict,
    summary: 'summary',
    issues: verdict === 'changes_requested' ? [{ path: 'a.ts', comment }] : [],
  });
}

function workdirFor(attempt: number) {
  return path.join(mocks.config.AGENT_WORKDIR, `review-task-1-${attempt}`);
}

// Review-pr jobs run inside the real workdir tree; the harness cleans up.
async function cleanTestWorkdirs() {
  await fs.rm(mocks.config.AGENT_WORKDIR, { recursive: true, force: true });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanTestWorkdirs();
  mocks.prisma.task.findUnique.mockResolvedValue(makeTask());
  mocks.prisma.taskEvent.count.mockResolvedValue(0);
  mocks.prisma.taskEvent.create.mockResolvedValue({});
  mocks.prepareAgentRuntime.mockImplementation(async () => ({
    cloneUrl: 'https://clone',
    gitAuth: { headers: {} },
    rt: stubRuntime(),
  }));
  mocks.getPullRequestDiff.mockResolvedValue('diff --git a/a.ts b/a.ts\n+bad code');
  mocks.checkoutTaskBranch.mockResolvedValue(undefined);
  mocks.cleanupWorkdir.mockImplementation(async (workdir: string) => {
    await fs.rm(workdir, { recursive: true, force: true });
  });
  mocks.commitAndPush.mockResolvedValue(undefined);
  mocks.hasMeaningfulChanges.mockResolvedValue(true);
  mocks.llmCall.mockResolvedValue({ text: 'done' });
  mocks.runLemcoreLoop.mockImplementation(async (opts: { workdir: string }) => {
    await fs.mkdir(opts.workdir, { recursive: true });
    await fs.writeFile(
      path.join(opts.workdir, '.lemniscate-review.json'),
      reviewJson('approve'),
    );
  });
  mocks.setTaskStatus.mockImplementation(async (taskId: string, status: string) => {
    const task = await mocks.prisma.task.findUnique({ where: { id: taskId } });
    if (task) task.status = status;
  });
});

afterEach(cleanTestWorkdirs);

describe('reviewTask guards', () => {
  it('logs an error and returns when the task does not exist', async () => {
    mocks.prisma.task.findUnique.mockResolvedValue(null);
    await reviewTask('missing');
    expect(mocks.setTaskStatus).not.toHaveBeenCalled();
  });

  it('does nothing when the task is no longer awaiting review', async () => {
    mocks.prisma.task.findUnique.mockResolvedValue(makeTask({ status: 'running' }));
    await reviewTask('task-1');
    expect(mocks.setTaskStatus).not.toHaveBeenCalled();
  });

  it('does nothing when the repository has auto-review off', async () => {
    mocks.prisma.task.findUnique.mockResolvedValue(
      makeTask({ repository: { ...makeTask().repository, autoReviewPr: false } }),
    );
    await reviewTask('task-1');
    expect(mocks.setTaskStatus).not.toHaveBeenCalled();
  });

  it('logs and returns when the task has no branch', async () => {
    mocks.prisma.task.findUnique.mockResolvedValue(makeTask({ branchName: null }));
    await reviewTask('task-1');
    expect(mocks.checkoutTaskBranch).not.toHaveBeenCalled();
  });

  it('stops at the review-loop cap and hands the PR back to awaiting_review', async () => {
    mocks.prisma.taskEvent.count.mockResolvedValue(3);
    await reviewTask('task-1', 1);
    expect(mocks.checkoutTaskBranch).not.toHaveBeenCalled();
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
  });
});

describe('reviewTask with lemcore', () => {
  it('sets reviewing_code at the start and waiting_ci when the review finishes', async () => {
    await reviewTask('task-1');
    const statuses = mocks.setTaskStatus.mock.calls.map((c) => c[1]);
    expect(statuses[0]).toBe('reviewing_code');
    expect(statuses).toContain('waiting_ci');
    expect(existsSync(workdirFor(0))).toBe(false);
  });

  it('on changes_requested: applies ONE fix, finishes, and never re-reviews', async () => {
    mocks.runLemcoreLoop
      .mockImplementationOnce(async (opts: { workdir: string }) => {
        await fs.mkdir(opts.workdir, { recursive: true });
        await fs.writeFile(
          path.join(opts.workdir, '.lemniscate-review.json'),
          reviewJson('changes_requested'),
        );
      })
      .mockResolvedValueOnce('');

    await reviewTask('task-1');

    expect(mocks.checkoutTaskBranch).toHaveBeenCalledWith(
      workdirFor(0),
      'https://clone',
      'main',
      BRANCH,
      [],
      { headers: {} },
    );
    // Fix iteration: one lemcore pass, then a push of the reviewed branch.
    expect(mocks.runLemcoreLoop).toHaveBeenCalledTimes(2);
    expect(mocks.commitAndPush).toHaveBeenCalledTimes(1);
    expect(mocks.commitAndPush).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      expect.anything(),
      workdirFor(0),
      'address review issues (lemcore)',
      ['push', 'origin', BRANCH],
      [],
      { headers: {} },
    );
    // One fix, then finish — no re-review, straight to the merge gate.
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('hands an approved PR on an auto-merge repo to the merge gate', async () => {
    await reviewTask('task-1');
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('stops after approval when auto-merge is off (manual merge)', async () => {
    mocks.prisma.task.findUnique.mockResolvedValue(
      makeTask({ repository: { ...makeTask().repository, autoMergePr: false } }),
    );
    await reviewTask('task-1');
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'waiting_ci');
  });

  it('parses an approve verdict out of the review file written by lemcore', async () => {
    await reviewTask('task-1');
    // The verdict file is consumed and deleted — never committed or reused.
    expect(existsSync(path.join(workdirFor(0), '.lemniscate-review.json'))).toBe(false);
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 0, 0);
  });

  it('treats an unparseable verdict as a retryable failure, not an approval', async () => {
    mocks.runLemcoreLoop.mockImplementation(async (opts: { workdir: string }) => {
      await fs.mkdir(opts.workdir, { recursive: true });
      await fs.writeFile(path.join(opts.workdir, '.lemniscate-review.json'), 'not json');
    });
    // The direct-review fallback also replies with junk → job fails and
    // BullMQ retries instead of silently approving the PR.
    await expect(reviewTask('task-1')).rejects.toThrow();
    expect(mocks.recordJobFailure).toHaveBeenCalledWith(
      'review-pr',
      'task-1',
      expect.anything(),
      [],
    );
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });

  it('rethrows LLM errors for BullMQ retry and still cleans up the workdir', async () => {
    mocks.runLemcoreLoop.mockRejectedValue(new Error('boom'));
    await expect(reviewTask('task-1')).rejects.toThrow('boom');
    expect(mocks.recordJobFailure).toHaveBeenCalledWith(
      'review-pr',
      'task-1',
      expect.any(Error),
      [],
    );
    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith(
      path.join(mocks.config.AGENT_WORKDIR, 'review-task-1-0'),
      'task-1',
    );
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });
});

describe('reviewTask rate-limit defer', () => {
  it('defers a rate-limited review instead of rethrowing', async () => {
    mocks.runLemcoreLoop.mockRejectedValue(
      new Error('HTTP 429 rate limit exceeded, reset at 2999-01-01 00:00:00'),
    );
    await reviewTask('task-1');
    expect(mocks.recordJobFailure).toHaveBeenCalledWith(
      'review-pr',
      'task-1',
      expect.any(Error),
      [],
    );
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
    expect(mocks.enqueueReviewTask).toHaveBeenCalledWith(
      'task-1',
      0,
      expect.any(Number),
      1,
    );
  });

  it('sequences defer jobIds so repeated pauses are never deduped away', async () => {
    mocks.prisma.taskEvent.count.mockResolvedValueOnce(0).mockResolvedValue(3);
    mocks.runLemcoreLoop.mockRejectedValue(new Error('HTTP 429 rate limit'));
    await reviewTask('task-1');
    expect(mocks.enqueueReviewTask).toHaveBeenCalledWith(
      'task-1',
      0,
      expect.any(Number),
      4,
    );
  });

  it('rethrows once the defer budget is exhausted', async () => {
    mocks.prisma.taskEvent.count.mockResolvedValueOnce(0).mockResolvedValue(12);
    mocks.runLemcoreLoop.mockRejectedValue(new Error('HTTP 429 rate limit'));
    await expect(reviewTask('task-1')).rejects.toThrow('429');
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
  });

  it('does not defer non-rate-limit failures', async () => {
    mocks.runLemcoreLoop.mockRejectedValue(new Error('connection refused'));
    await expect(reviewTask('task-1')).rejects.toThrow('connection refused');
    expect(mocks.enqueueReviewTask).not.toHaveBeenCalled();
  });
});
