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
  enqueueReviewTask: vi.fn(),
  openPullRequest: vi.fn(),
  buildRepoContext: vi.fn(),
  setTaskStatus: vi.fn(),
  runHermesTask: vi.fn(),
}));

vi.mock('../src/config.js', () => ({ config: mocks.config }));
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
}));
vi.mock('../src/lib/prisma.js', () => ({ prisma: { task: { update: mocks.taskUpdate } } }));
vi.mock('../src/lib/proposal-scheduler.js', () => ({ enqueueReviewTask: mocks.enqueueReviewTask }));
vi.mock('../src/lib/pull-requests.js', () => ({ openPullRequest: mocks.openPullRequest }));
vi.mock('../src/lib/repo-context.js', () => ({ buildRepoContext: mocks.buildRepoContext }));
vi.mock('../src/lib/task-events.js', () => ({ setTaskStatus: mocks.setTaskStatus }));
vi.mock('../src/lib/hermes-runner.js', () => ({ runHermesTask: mocks.runHermesTask }));

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
      connection: {},
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
  mocks.loadTaskWithRepo.mockResolvedValue(stubTask());
  mocks.prepareAgentRuntime.mockResolvedValue({ cloneUrl: 'https://clone', rt: stubRuntime() });
  mocks.generateBranchName.mockResolvedValue('lemniscate/add-feature-x');
  mocks.hasDirtyWorkdir.mockResolvedValue(true);
  mocks.buildPrBody.mockReturnValue('pr body');
  mocks.openPullRequest.mockResolvedValue({ prUrl: 'https://pr/1' });
  mocks.recordJobFailure.mockResolvedValue('recorded failure');
  mocks.setTaskStatus.mockResolvedValue(undefined);
  mocks.taskUpdate.mockResolvedValue(undefined);
  mocks.persistTokenUsage.mockResolvedValue(undefined);
  mocks.cleanupWorkdir.mockResolvedValue(undefined);
  mocks.logEvent.mockResolvedValue(undefined);
  mocks.runHermesTask.mockResolvedValue(undefined);
});

describe('runTask with AGENT_EXECUTOR=hermes', () => {
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

  it('finishes without committing when hermes left the workdir clean', async () => {
    mocks.hasDirtyWorkdir.mockResolvedValue(false);
    await runTask('task-1');

    expect(mocks.runHermesTask).toHaveBeenCalled();
    expect(mocks.commitAndPush).not.toHaveBeenCalled();
    expect(mocks.openPullRequest).not.toHaveBeenCalled();
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'done');
  });
});

describe('runTask with AGENT_EXECUTOR=internal', () => {
  it('keeps the existing LLM propose/apply loop and never spawns hermes', async () => {
    mocks.config.AGENT_EXECUTOR = 'internal';
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
