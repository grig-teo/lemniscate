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
  hasMeaningfulChanges: vi.fn(),
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
  claimTaskForRun: vi.fn(),
  RUN_CLAIMABLE_STATUSES: ['queued', 'pending'],
  openPullRequest: vi.fn(),
  buildRepoContext: vi.fn(),
  setTaskStatus: vi.fn(),
  runHermesTask: vi.fn(),
  runLemcoreTask: vi.fn(),
  resolveAgentExecutor: vi.fn(),
  notify: vi.fn(),
  notifyTaskCompleted: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() },
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
vi.mock('../src/lib/workdir-changes.js', () => ({
  hasMeaningfulChanges: mocks.hasMeaningfulChanges,
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
vi.mock('../src/lib/task-claim.js', () => ({
  claimTaskForRun: mocks.claimTaskForRun,
  RUN_CLAIMABLE_STATUSES: mocks.RUN_CLAIMABLE_STATUSES,
}));
vi.mock('../src/lib/pull-requests.js', () => ({ openPullRequest: mocks.openPullRequest }));
vi.mock('../src/lib/repo-context.js', () => ({ buildRepoContext: mocks.buildRepoContext }));
// The repo-digest side quest (LLM call + prisma write) is not under test here.
vi.mock('../src/lib/repo-digest.js', () => ({
  ensureRepoDigest: vi.fn(async () => null),
  withRepoDigest: (context: string) => context,
}));
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
  mocks.loadTaskWithRepo.mockResolvedValue(stubTask());
  mocks.prepareAgentRuntime.mockResolvedValue({ cloneUrl: 'https://clone', rt: stubRuntime() });
  mocks.cloneRepository.mockResolvedValue({ emptyRepo: false });
  mocks.generateBranchName.mockResolvedValue('lemniscate/add-feature-x');
  mocks.hasMeaningfulChanges.mockResolvedValue(true);
  mocks.buildPrBody.mockReturnValue('pr body');
  mocks.openPullRequest.mockResolvedValue({ prUrl: 'https://pr/1' });
  mocks.recordJobFailure.mockResolvedValue('recorded failure');
  mocks.setTaskStatus.mockResolvedValue(undefined);
  mocks.taskUpdate.mockResolvedValue(undefined);
  // The atomic claim succeeds by default; concurrency tests override this.
  mocks.taskUpdateMany.mockResolvedValue({ count: 1 });
  // claimTaskForRun: first call wins the initial claim; retries keep winning
  // unless a test simulates a lost requeue (returns false to stand down).
  mocks.claimTaskForRun.mockResolvedValue(true);
  mocks.enqueueRunTask.mockResolvedValue(undefined);
  mocks.persistTokenUsage.mockResolvedValue(undefined);
  mocks.cleanupWorkdir.mockResolvedValue(undefined);
  mocks.logEvent.mockResolvedValue(undefined);
  // The real git() returns stdout (a string); default to '' so callers that
  // chain .catch on the result (pushBranch's best-effort fetch) work.
  mocks.git.mockResolvedValue('');
  mocks.runHermesTask.mockResolvedValue(undefined);
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

  it('does not commit/push when hermes left the workdir clean (and never marks done)', async () => {
    // A clean workdir with no open PR used to be marked 'done' — a green task
    // with zero deliverable. It now retries once then fails; either way the
    // run never commits, pushes, or opens a PR, and is never 'done'.
    mocks.hasMeaningfulChanges.mockResolvedValue(false);
    mocks.taskFindUnique.mockResolvedValue({ status: 'queued' });
    await runTask('task-1');

    expect(mocks.runHermesTask).toHaveBeenCalled();
    expect(mocks.commitAndPush).not.toHaveBeenCalled();
    expect(mocks.openPullRequest).not.toHaveBeenCalled();
    expect(mocks.setTaskStatus).not.toHaveBeenCalledWith('task-1', 'done');
  });

  it('returns to awaiting_review instead of done when a PR is already open', async () => {
    // A duplicate/resumed run that finds nothing new must not close the
    // pipeline: the open PR continues through review/merge — 'done' is only
    // for merged work (or no-PR flows).
    mocks.hasMeaningfulChanges.mockResolvedValue(false);
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
    // First invocation wins the atomic claim; the second (BullMQ stalled
    // re-delivery / double-enqueue) loses and stands down.
    mocks.claimTaskForRun
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await Promise.all([runTask('task-1'), runTask('task-1')]);

    expect(mocks.claimTaskForRun).toHaveBeenCalledTimes(2);
    expect(mocks.runHermesTask).toHaveBeenCalledTimes(1);
    expect(mocks.commitAndPush).toHaveBeenCalledTimes(1);
    expect(mocks.openPullRequest).toHaveBeenCalledTimes(1);
  });

  it('never touches the shared workdir when the claim is lost', async () => {
    mocks.claimTaskForRun.mockResolvedValue(false);

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

    expect(mocks.claimTaskForRun).toHaveBeenCalledWith('task-1');
  });
});

describe('runTask push over a same-named remote branch (rerun)', () => {
  // A rerun regenerates the same branch name (slug derived from the task
  // title), so the remote usually still holds the previous run's commits.
  // A plain push is rejected as non-fast-forward; the run-task push must
  // fetch the remote ref and push with --force-with-lease instead — the
  // same pattern as merge-gate-rebase's force-push.
  const workdir = path.join('/tmp/test-workdirs', 'task-1');

  it('fetches the task branch and force-pushes-with-lease', async () => {
    await runTask('task-1');

    // Lease has to reflect the remote's current tip, so fetch the branch
    // into a tracking ref before the push (a fresh shallow clone has none).
    expect(mocks.git).toHaveBeenCalledWith(
      ['fetch', 'origin', '+refs/heads/lemniscate/add-feature-x:refs/remotes/origin/lemniscate/add-feature-x'],
      expect.objectContaining({ cwd: workdir }),
    );

    // The push carries --force-with-lease so a diverged remote branch from a
    // prior run is overwritten cleanly instead of being rejected.
    const pushCall = mocks.commitAndPush.mock.calls.at(-1)!;
    expect(pushCall[2]).toBe(workdir); // workdir
    expect(pushCall[4]).toEqual([
      'push',
      '-u',
      '--force-with-lease',
      'origin',
      'lemniscate/add-feature-x',
    ]);
  });

  it('still pushes (first run) when the fetch finds no remote branch yet', async () => {
    // The fetch is best-effort: a brand-new branch has no remote ref, so the
    // fetch exits non-zero. The push must still happen — --force-with-lease
    // creates a new branch when no remote ref exists to lease against.
    mocks.git.mockImplementation(async (args: string[]) => {
      if (args[0] === 'fetch') throw new Error('fetch failed');
      return '';
    });
    await runTask('task-1');

    const pushCall = mocks.commitAndPush.mock.calls.at(-1)!;
    expect(pushCall[4]).toEqual([
      'push',
      '-u',
      '--force-with-lease',
      'origin',
      'lemniscate/add-feature-x',
    ]);
  });
});

describe('runTask no-changes retry (prevent premature done)', () => {
  // A run whose agent left the worktree clean and with no open PR used to be
  // marked 'done' — a green task with zero deliverable. Now it retries once
  // (requeue + stronger prompt), then 'failed' if still empty. 'done' is
  // reserved for runs that produced something.

  it('requeues one retry when hermes left the workdir clean, then completes', async () => {
    // Attempt 1: clean workdir → requeue. Attempt 2: dirty → normal PR flow.
    mocks.hasMeaningfulChanges.mockResolvedValueOnce(false).mockResolvedValue(true);
    mocks.taskFindUnique.mockResolvedValue({ status: 'queued' }); // settle check sees requeue
    await runTask('task-1');

    // Two implementation passes (the retry), both hermes.
    expect(mocks.runHermesTask).toHaveBeenCalledTimes(2);
    // The retry prompt nudges the agent that the previous attempt was empty.
    const retryPrompt = mocks.runHermesTask.mock.calls[1]?.[0]?.prompt ?? '';
    expect(retryPrompt).toContain('previous attempt finished without changing a single file');
    // The requeue happened: status flipped to 'queued' and the job re-enqueued.
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'queued');
    expect(mocks.enqueueRunTask).toHaveBeenCalledWith('task-1');
  });

  it('fails the task after the final attempt instead of marking done', async () => {
    // Both attempts leave the worktree clean and no PR exists: the run ends
    // 'failed' with a clear message — never 'done'.
    mocks.hasMeaningfulChanges.mockResolvedValue(false);
    mocks.taskFindUnique.mockResolvedValue({ status: 'queued' });
    await runTask('task-1');

    expect(mocks.runHermesTask).toHaveBeenCalledTimes(2);
    expect(mocks.setTaskStatus).not.toHaveBeenCalledWith('task-1', 'done');
    expect(mocks.setTaskStatus).toHaveBeenCalledWith(
      'task-1',
      'failed',
      expect.objectContaining({ errorCode: expect.any(String) }),
    );
    expect(mocks.recordJobFailure).toHaveBeenCalled();
  });

  it('stands down when the requeued task is no longer claimable (cancelled mid-run)', async () => {
    // Attempt 1 requeues; by the settle check the task left the claimable
    // states (user cancelled) — the retry must not run.
    mocks.hasMeaningfulChanges.mockResolvedValueOnce(false);
    mocks.taskFindUnique.mockResolvedValue({ status: 'failed' }); // cancelled → failed
    await runTask('task-1');

    expect(mocks.runHermesTask).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTaskCompleted).not.toHaveBeenCalled();
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
