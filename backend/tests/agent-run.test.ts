import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {
    AGENT_EXECUTOR: 'hermes' as string,
    AGENT_WORKDIR: '/tmp/test-workdirs',
    AGENT_BRANCH_PREFIX: 'lemniscate/',
    AGENT_HERMES_TIMEOUT_MINUTES: 45,
  },
  applyChanges: vi.fn(),
  cleanupWorkdir: vi.fn(),
  cloneRepository: vi.fn(),
  commitAndPush: vi.fn(),
  git: vi.fn(),
  hasDirtyWorkdir: vi.fn(),
  logEvent: vi.fn(),
  persistTokenUsage: vi.fn(),
  recordJobFailure: vi.fn(),
  buildPrBody: vi.fn(),
  generateBranchName: vi.fn(),
  requestChanges: vi.fn(),
  loadTaskWithRepo: vi.fn(),
  prepareAgentRuntime: vi.fn(),
  taskUpdate: vi.fn(),
  taskUpdateMany: vi.fn(),
  taskFindUnique: vi.fn(),
  enqueueReviewTask: vi.fn(),
  enqueueRunTask: vi.fn(),
  openPullRequest: vi.fn(),
  buildRepoContext: vi.fn(),
  setTaskStatus: vi.fn(),
  runHermesTask: vi.fn(),
  runLemcoreTask: vi.fn(),
  resolveAgentExecutor: vi.fn(),
  notify: vi.fn(),
  notifyTaskCompleted: vi.fn(),
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/lib/logger.js', () => ({
  logger: mocks.logger,
  createLogger: vi.fn(() => mocks.logger),
}));
vi.mock('../src/lib/agent-git.js', () => ({
  applyChanges: mocks.applyChanges,
  cleanupWorkdir: mocks.cleanupWorkdir,
  cloneRepository: mocks.cloneRepository,
  commitAndPush: mocks.commitAndPush,
  git: mocks.git,
  hasDirtyWorkdir: mocks.hasDirtyWorkdir,
  logEvent: mocks.logEvent,
  persistTokenUsage: mocks.persistTokenUsage,
  recordJobFailure: mocks.recordJobFailure,
}));
vi.mock('../src/lib/agent-prompts.js', () => ({
  buildPrBody: mocks.buildPrBody,
  generateBranchName: mocks.generateBranchName,
  requestChanges: mocks.requestChanges,
}));
vi.mock('../src/lib/agent-runtime.js', () => ({
  loadTaskWithRepo: mocks.loadTaskWithRepo,
  prepareAgentRuntime: mocks.prepareAgentRuntime,
  tokenSplit: (rt: { usedPromptTokens?: number; usedCompletionTokens?: number }) => ({
    promptTokens: rt.usedPromptTokens ?? 0,
    completionTokens: rt.usedCompletionTokens ?? 0,
  }),
}));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    task: {
      update: mocks.taskUpdate,
      updateMany: mocks.taskUpdateMany,
      findUnique: mocks.taskFindUnique,
    },
  },
}));
vi.mock('../src/lib/proposal-scheduler.js', () => ({
  enqueueReviewTask: mocks.enqueueReviewTask,
  enqueueRunTask: mocks.enqueueRunTask,
}));
vi.mock('../src/lib/pull-requests.js', () => ({ openPullRequest: mocks.openPullRequest }));
vi.mock('../src/lib/repo-context.js', () => ({ buildRepoContext: mocks.buildRepoContext }));
vi.mock('../src/lib/task-events.js', () => ({ setTaskStatus: mocks.setTaskStatus }));
vi.mock('../src/lib/hermes-runner.js', () => ({ runHermesTask: mocks.runHermesTask }));
vi.mock('../src/lib/agent-run-hermes.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/agent-run-hermes.js')>(
    '../src/lib/agent-run-hermes.js',
  );
  return actual;
});
vi.mock('../src/lib/agent-executor.js', () => ({
  resolveAgentExecutor: mocks.resolveAgentExecutor,
  parseAgentExecutor: (v: unknown) =>
    v === 'hermes' || v === 'internal' || v === 'lemcore' ? v : null,
  defaultAgentExecutor: () => 'hermes',
  AGENT_EXECUTORS: ['hermes', 'internal', 'lemcore'],
}));
vi.mock('../src/lib/lemcore/run.js', () => ({ runLemcoreTask: mocks.runLemcoreTask }));
vi.mock('../src/lib/notifications.js', () => ({
  notify: mocks.notify,
  notifyTaskCompleted: mocks.notifyTaskCompleted,
}));

import { runTask } from '../src/lib/agent-run.js';

// Executor branch selection in run-task: 'hermes' delegates the
// implementation step to the Hermes CLI (skipping the internal
// context/propose/apply loop) while branch/commit/push/PR stay unchanged;
// 'internal' keeps the existing LLM change loop.

function stubTask() {
  return {
    id: 'task-1',
    title: 'Add feature X',
    prompt: 'Implement feature X',
    status: 'pending',
    llmTokensUsed: 0,
    repository: {
      fullName: 'acme/widgets',
      defaultBranch: 'main',
      autoCreatePr: true,
      autoReviewPr: false,
      connection: { userId: 'user-1' },
    },
  };
}

function stubRuntime() {
  return {
    cfg: {
      baseUrl: 'https://llm.example/v1',
      model: 'model-x',
      contextWindow: 128_000,
      systemPromptExtra: 'Follow house style',
    },
    apiKey: 'sk-test',
    usedTokens: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.AGENT_EXECUTOR = 'hermes';
  mocks.resolveAgentExecutor.mockResolvedValue('hermes');
  mocks.runLemcoreTask.mockResolvedValue({ changed: true });
  mocks.loadTaskWithRepo.mockImplementation(() => Promise.resolve(stubTask()));
  mocks.prepareAgentRuntime.mockResolvedValue({ cloneUrl: 'https://clone', rt: stubRuntime() });
  mocks.cloneRepository.mockResolvedValue({ emptyRepo: false });
  mocks.generateBranchName.mockResolvedValue('lemniscate/add-feature-x');
  mocks.hasDirtyWorkdir.mockResolvedValue(true);
  mocks.buildPrBody.mockReturnValue('pr body');
  mocks.openPullRequest.mockResolvedValue({ prUrl: 'https://pr/1' });
  mocks.recordJobFailure.mockResolvedValue('recorded failure');
  mocks.setTaskStatus.mockResolvedValue(undefined);
  mocks.taskUpdate.mockResolvedValue(undefined);
  // The atomic claim succeeds by default; concurrency tests override this.
  mocks.taskUpdateMany.mockResolvedValue({ count: 1 });
  mocks.persistTokenUsage.mockResolvedValue(undefined);
  mocks.cleanupWorkdir.mockResolvedValue(undefined);
  mocks.logEvent.mockResolvedValue(undefined);
  mocks.runHermesTask.mockResolvedValue(undefined);
  mocks.enqueueRunTask.mockResolvedValue(undefined);
  mocks.notifyTaskCompleted.mockResolvedValue(undefined);
  // Post-run status read for the workdir-retention check: the happy-path
  // flows above end in awaiting_review.
  mocks.taskFindUnique.mockResolvedValue({ status: 'awaiting_review' });
});

describe('runTask with resolveAgentExecutor=hermes', () => {
  it('runs the hermes CLI instead of the internal LLM change loop', async () => {
    await runTask('task-1');

    expect(mocks.runHermesTask).toHaveBeenCalledTimes(1);
    const opts = mocks.runHermesTask.mock.calls[0]?.[0];
    expect(opts.workdir).toBe(path.join('/tmp/test-workdirs', 'task-1'));
    expect(opts.taskId).toBe('task-1');
    expect(opts.timeoutMs).toBe(45 * 60_000);
    expect(opts.llm).toEqual({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-test',
      model: 'model-x',
      contextWindow: 128_000,
    });
    expect(opts.prompt).toContain('Add feature X');
    expect(opts.prompt).toContain('Implement feature X');
    expect(opts.prompt).toContain('Follow house style');
    expect(opts.prompt).toContain('Do NOT git commit');
    expect(mocks.buildRepoContext).not.toHaveBeenCalled();
    expect(mocks.requestChanges).not.toHaveBeenCalled();
    expect(mocks.applyChanges).not.toHaveBeenCalled();
  });

  it('keeps the existing branch/commit/push/PR flow after hermes', async () => {
    await runTask('task-1');

    expect(mocks.generateBranchName).toHaveBeenCalled();
    expect(mocks.git).toHaveBeenCalledWith(
      ['checkout', '-b', 'lemniscate/add-feature-x'],
      expect.objectContaining({ cwd: path.join('/tmp/test-workdirs', 'task-1') }),
    );
    expect(mocks.commitAndPush).toHaveBeenCalled();
    expect(mocks.openPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headBranch: 'lemniscate/add-feature-x',
        baseBranch: 'main',
        title: 'Add feature X',
      }),
    );
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
  });

  it('notifies the repo owner that the PR awaits review', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue({
      ...stubTask(),
      repository: { ...stubTask().repository, connection: { userId: 'user-1' } },
    });
    await runTask('task-1');

    expect(mocks.notify).toHaveBeenCalledWith('user-1', 'pr_opened', {
      title: 'PR opened: Add feature X',
      body: 'acme/widgets — pull request is awaiting review',
      taskId: 'task-1',
      prUrl: 'https://pr/1',
    });
  });

  it('requeues one retry with a stronger prompt when hermes left the workdir clean', async () => {
    // Attempt 1 leaves the worktree clean → requeue; the retry (attempt 2)
    // gets the no-changes prompt, makes changes, and the PR flow proceeds.
    mocks.hasDirtyWorkdir.mockResolvedValueOnce(false).mockResolvedValue(true);
    // taskFindUnique serves two readers: the retry settle check (must see
    // the requeued 'queued' status) and the final workdir-retention check
    // (sees the terminal status).
    mocks.taskFindUnique
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValue({ status: 'awaiting_review' });
    await runTask('task-1');

    expect(mocks.runHermesTask).toHaveBeenCalledTimes(2);
    const retryPrompt = mocks.runHermesTask.mock.calls[1]?.[0]?.prompt ?? '';
    expect(retryPrompt).toContain('previous attempt finished without changing a single file');
    expect(mocks.commitAndPush).toHaveBeenCalledTimes(1);
    expect(mocks.openPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'queued');
    expect(mocks.enqueueRunTask).toHaveBeenCalledWith('task-1');
    // The task was re-claimed before the second attempt.
    expect(mocks.taskUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
    expect(mocks.setTaskStatus).not.toHaveBeenCalledWith('task-1', 'done');
  });

  it('fails with the no-changes error after the final attempt instead of done', async () => {
    // Both attempts leave the worktree clean and no PR exists: the run is
    // 'failed' with a clear message — 'done' is reserved for runs that
    // actually produced something.
    mocks.hasDirtyWorkdir.mockResolvedValue(false);
    mocks.taskFindUnique
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValue({ status: 'failed' });
    await runTask('task-1');

    expect(mocks.runHermesTask).toHaveBeenCalledTimes(2);
    expect(mocks.commitAndPush).not.toHaveBeenCalled();
    expect(mocks.openPullRequest).not.toHaveBeenCalled();
    expect(mocks.enqueueRunTask).toHaveBeenCalledWith('task-1');
    expect(mocks.setTaskStatus).toHaveBeenCalledWith(
      'task-1',
      'failed',
      expect.objectContaining({
        error: expect.stringContaining('finished without making any changes'),
      }),
    );
    expect(mocks.setTaskStatus).not.toHaveBeenCalledWith('task-1', 'done');
    expect(mocks.notifyTaskCompleted).not.toHaveBeenCalled();
    expect(mocks.recordJobFailure).toHaveBeenCalled();
  });

  it('returns to awaiting_review instead of done when a PR is already open', async () => {
    // A duplicate/resumed run that finds nothing new must not close the
    // pipeline: the open PR continues through review/merge — 'done' is only
    // for merged work (or no-PR flows).
    mocks.hasDirtyWorkdir.mockResolvedValue(false);
    mocks.loadTaskWithRepo.mockResolvedValue({ ...stubTask(), prUrl: 'https://pr/1' });
    await runTask('task-1');

    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
    expect(mocks.setTaskStatus).not.toHaveBeenCalledWith('task-1', 'done');
  });

  it('emits the task-completed hook after a successful run', async () => {
    await runTask('task-1');
    expect(mocks.notifyTaskCompleted).toHaveBeenCalledWith('task-1');
  });

  it('logs but does not fail the run when the completion hook rejects', async () => {
    mocks.notifyTaskCompleted.mockRejectedValueOnce(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runTask('task-1');
      expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1' }),
        expect.stringContaining('task_completed'),
      );
    } finally {
      error.mockRestore();
    }
  });

  it('does not emit the task-completed hook when the run fails', async () => {
    mocks.runHermesTask.mockRejectedValueOnce(new Error('boom'));
    await runTask('task-1');
    expect(mocks.recordJobFailure).toHaveBeenCalled();
    expect(mocks.notifyTaskCompleted).not.toHaveBeenCalled();
  });
});

describe('runTask no-changes retry claim gate', () => {
  it('stands down when the requeued task is no longer claimable (cancelled mid-run)', async () => {
    // Attempt 1 leaves a clean worktree and requeues; by the settle check
    // the task left the claimable states, so the retry must not run.
    mocks.hasDirtyWorkdir.mockResolvedValue(false);
    mocks.taskFindUnique.mockResolvedValue({ status: 'cancelled' });
    await runTask('task-1');

    expect(mocks.runHermesTask).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueRunTask).toHaveBeenCalledWith('task-1');
    // No second claim attempt, no completion hook.
    expect(mocks.taskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTaskCompleted).not.toHaveBeenCalled();
  });

  it('stands down when a duplicate executor won the requeue claim', async () => {
    // The requeue was picked up by another worker first: our second claim
    // matches 0 rows and this executor stops before touching the workdir.
    mocks.hasDirtyWorkdir.mockResolvedValue(false);
    mocks.taskUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await runTask('task-1');

    expect(mocks.taskUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.runHermesTask).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTaskCompleted).not.toHaveBeenCalled();
  });
});

describe('runTask with resolveAgentExecutor=internal', () => {
  it('keeps the existing LLM propose/apply loop and never spawns hermes', async () => {
    mocks.resolveAgentExecutor.mockResolvedValue('internal');
    mocks.buildRepoContext.mockResolvedValue({ text: 'ctx', files: [] });
    mocks.requestChanges.mockResolvedValue({
      summary: 'did stuff',
      changes: [{ path: 'a.ts', action: 'create', content: 'x' }],
    });
    mocks.applyChanges.mockResolvedValue(1);

    await runTask('task-1');

    expect(mocks.runHermesTask).not.toHaveBeenCalled();
    expect(mocks.requestChanges).toHaveBeenCalled();
    expect(mocks.applyChanges).toHaveBeenCalled();
    expect(mocks.commitAndPush).toHaveBeenCalled();
    expect(mocks.openPullRequest).toHaveBeenCalled();
  });
});


describe('runTask with resolveAgentExecutor=lemcore', () => {
  it('runs lemcore even when the deployment default is hermes', async () => {
    mocks.config.AGENT_EXECUTOR = 'hermes';
    mocks.resolveAgentExecutor.mockResolvedValue('lemcore');
    await runTask('task-1');

    expect(mocks.resolveAgentExecutor).toHaveBeenCalledWith('user-1');
    expect(mocks.runLemcoreTask).toHaveBeenCalledTimes(1);
    expect(mocks.runHermesTask).not.toHaveBeenCalled();
    expect(mocks.requestChanges).not.toHaveBeenCalled();
    expect(mocks.commitAndPush).toHaveBeenCalled();
    expect(mocks.openPullRequest).toHaveBeenCalled();
  });
});

describe('runTask on an empty repository', () => {
  it('bootstraps on the default branch and finishes without a PR', async () => {
    mocks.cloneRepository.mockResolvedValue({ emptyRepo: true });
    await runTask('task-1');

    expect(mocks.runHermesTask).toHaveBeenCalledTimes(1);
    expect(mocks.generateBranchName).not.toHaveBeenCalled();
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { branchName: 'main' },
    });
    expect(mocks.openPullRequest).not.toHaveBeenCalled();
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'done');
  });
});

describe('runTask resumption after an interrupted run', () => {
  const workdir = path.join('/tmp/test-workdirs', 'task-1');

  it('resumes from the saved workdir instead of cloning when branch and clone exist', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue({
      ...stubTask(),
      status: 'queued',
      branchName: 'lemniscate/add-feature-x',
    });
    await fs.mkdir(path.join(workdir, '.git'), { recursive: true });
    try {
      await runTask('task-1');
    } finally {
      await fs.rm('/tmp/test-workdirs', { recursive: true, force: true });
    }

    expect(mocks.cloneRepository).not.toHaveBeenCalled();
    expect(mocks.generateBranchName).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('resuming task'),
    );
    const opts = mocks.runHermesTask.mock.calls[0]?.[0];
    expect(opts.prompt).toContain('RESUMED RUN');
    expect(mocks.commitAndPush).toHaveBeenCalled();
    expect(mocks.openPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headBranch: 'lemniscate/add-feature-x' }),
    );
  });

  it('starts fresh when the task has a branch but no saved workdir', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue({
      ...stubTask(),
      status: 'queued',
      branchName: 'lemniscate/add-feature-x',
    });
    await fs.rm('/tmp/test-workdirs', { recursive: true, force: true });
    await runTask('task-1');

    expect(mocks.cloneRepository).toHaveBeenCalled();
    expect(mocks.generateBranchName).toHaveBeenCalled();
    const opts = mocks.runHermesTask.mock.calls[0]?.[0];
    expect(opts.prompt).not.toContain('RESUMED RUN');
  });
});

describe('runTask exactly-once claim', () => {
  it('runs exactly once when two deliveries race for the same task', async () => {
    // First invocation wins the conditional update; the second (BullMQ
    // stalled re-delivery / double-enqueue) matches 0 rows and stands down.
    mocks.taskUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await Promise.all([runTask('task-1'), runTask('task-1')]);

    expect(mocks.taskUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.runHermesTask).toHaveBeenCalledTimes(1);
    expect(mocks.commitAndPush).toHaveBeenCalledTimes(1);
    expect(mocks.openPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1' }),
      expect.stringContaining('already claimed'),
    );
  });

  it('never touches the shared workdir when the claim is lost', async () => {
    mocks.taskUpdateMany.mockResolvedValue({ count: 0 });

    await runTask('task-1');

    expect(mocks.cloneRepository).not.toHaveBeenCalled();
    expect(mocks.runHermesTask).not.toHaveBeenCalled();
    expect(mocks.commitAndPush).not.toHaveBeenCalled();
    expect(mocks.cleanupWorkdir).not.toHaveBeenCalledWith(
      path.join('/tmp/test-workdirs', 'task-1'),
      'task-1',
    );
    expect(mocks.notifyTaskCompleted).not.toHaveBeenCalled();
  });

  it('claims before doing any work, flipping the task to running', async () => {
    await runTask('task-1');

    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: 'task-1', status: { in: ['queued', 'pending'] } },
      data: { status: 'running' },
    });
  });
});

describe('runTask workdir retention', () => {
  it('keeps the workdir while the task awaits review', async () => {
    await runTask('task-1');

    // The only cleanupWorkdir call is the pre-clone sweep (no taskId); the
    // owned workdir itself is kept for the review window.
    expect(mocks.cleanupWorkdir).not.toHaveBeenCalledWith(
      path.join('/tmp/test-workdirs', 'task-1'),
      'task-1',
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      'workdir kept until the pull request is merged',
    );
  });

  it('removes the workdir when the task finishes done without a PR', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue({
      ...stubTask(),
      repository: { ...stubTask().repository, autoCreatePr: false },
    });
    mocks.taskFindUnique.mockResolvedValue({ status: 'done' });
    await runTask('task-1');

    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith(
      path.join('/tmp/test-workdirs', 'task-1'),
      'task-1',
    );
  });

  it('removes the workdir when the run fails', async () => {
    mocks.runHermesTask.mockRejectedValue(new Error('agent crashed'));
    mocks.taskFindUnique.mockResolvedValue({ status: 'failed' });
    await runTask('task-1');

    expect(mocks.setTaskStatus).toHaveBeenCalledWith(
      'task-1',
      'failed',
      expect.objectContaining({ error: 'recorded failure' }),
    );
    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith(
      path.join('/tmp/test-workdirs', 'task-1'),
      'task-1',
    );
  });
});
