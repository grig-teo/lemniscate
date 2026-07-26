import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Task-level locking tests for mergeGateTask (merge-gate.ts): the pure
// decision table lives in tests/merge-gate.test.ts — here we pin everything
// the decision DRIVES: pending re-enqueue with attempt/ciFixes job identity,
// the hermes CI-fix path, conflict resolution (internal LLM and hermes), the
// actual merge + deploy fan-out, and the record-then-rethrow failure path.
// Prisma, git, the queue, and providers are mocked; conflict files are real
// files in a tmp workdir so file rewrites are pinned too.

const mocks = vi.hoisted(() => ({
  config: {
    AGENT_EXECUTOR: 'internal' as string,
    AGENT_WORKDIR: '/tmp/test-workdirs-gate',
    AGENT_HERMES_TIMEOUT_MINUTES: 45,
  },
  checkoutTaskBranch: vi.fn(),
  cleanupWorkdir: vi.fn(),
  cloneRepository: vi.fn(),
  commitAndPush: vi.fn(),
  git: vi.fn(),
  hasDirtyWorkdir: vi.fn(),
  logEvent: vi.fn(),
  persistTokenUsage: vi.fn(),
  recordJobFailure: vi.fn(),
  llmCall: vi.fn(),
  loadTaskWithRepo: vi.fn(),
  prepareAgentRuntime: vi.fn(),
  runHermesTask: vi.fn(),
  enqueueMergeGate: vi.fn(),
  queueDeployment: vi.fn(),
  serviceFindUnique: vi.fn(),
  mergePullRequest: vi.fn(),
  pullRequestChecksStatus: vi.fn(),
  publishTaskEvent: vi.fn(),
  setTaskStatus: vi.fn(),
}));

vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/lib/agent-git.js', () => ({
  checkoutTaskBranch: mocks.checkoutTaskBranch,
  cleanupWorkdir: mocks.cleanupWorkdir,
  cloneRepository: mocks.cloneRepository,
  commitAndPush: mocks.commitAndPush,
  git: mocks.git,
  hasDirtyWorkdir: mocks.hasDirtyWorkdir,
  logEvent: mocks.logEvent,
  persistTokenUsage: mocks.persistTokenUsage,
  recordJobFailure: mocks.recordJobFailure,
  sanitizeRelativePath: (p: string) => p,
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
vi.mock('../src/lib/proposal-scheduler.js', () => ({ enqueueMergeGate: mocks.enqueueMergeGate }));
vi.mock('../src/lib/deploy/deploy-service.js', () => ({
  queueDeployment: mocks.queueDeployment,
}));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { service: { findUnique: mocks.serviceFindUnique } },
}));
vi.mock('../src/lib/pull-requests.js', () => ({
  mergePullRequest: mocks.mergePullRequest,
  pullRequestChecksStatus: mocks.pullRequestChecksStatus,
}));
vi.mock('../src/lib/task-events.js', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
  setTaskStatus: mocks.setTaskStatus,
}));

// pr-review.js (parseResolvedFile, hasConflictMarkers, prompt builders) is
// intentionally NOT mocked: conflict-marker safety is behavior under test.
import {
  MAX_CI_FIX_ATTEMPTS,
  MERGE_GATE_DELAY_MS,
  MERGE_GATE_MAX_ATTEMPTS,
  mergeGateTask,
} from '../src/lib/merge-gate.js';

const BRANCH = 'lemniscate/feature-x';

const green = { supported: true, green: true, state: 'green' as const };
const pending = { supported: true, green: false, state: 'pending' as const };
const failing = { supported: true, green: false, state: 'failing' as const };
const unsupported = { supported: false, green: true, state: 'green' as const };

function stubTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    repositoryId: 'repo-1',
    title: 'Add feature X',
    status: 'awaiting_review',
    branchName: BRANCH,
    llmTokensUsed: 0,
    repository: {
      fullName: 'acme/widgets',
      defaultBranch: 'main',
      autoMergePr: true,
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

function gateWorkdir(attempt = 0, ciFixes = 0) {
  return path.join(mocks.config.AGENT_WORKDIR, `merge-gate-task-1-${attempt}-${ciFixes}`);
}

const CONFLICTED = ['line a', '<<<<<<< HEAD', 'base', '=======', 'branch', '>>>>>>> b'].join('\n');

// Local merge of FETCH_HEAD always conflicts on src/a.ts.
function gitWithConflict(files = ['src/a.ts']) {
  return async (args: string[]) => {
    if (args[0] === 'merge') throw new Error('CONFLICT (content)');
    if (args[0] === 'diff') return `${files.join('\n')}\n`;
    return '';
  };
}

async function seedConflictedWorkdir(workdir: string) {
  await fs.mkdir(path.join(workdir, 'src'), { recursive: true });
  await fs.writeFile(path.join(workdir, 'src/a.ts'), CONFLICTED);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.AGENT_EXECUTOR = 'internal';
  mocks.loadTaskWithRepo.mockResolvedValue(stubTask());
  mocks.pullRequestChecksStatus.mockResolvedValue(green);
  mocks.prepareAgentRuntime.mockResolvedValue({
    cloneUrl: 'https://clone',
    gitAuth: { headers: {} },
    rt: stubRuntime(),
  });
  mocks.mergePullRequest.mockResolvedValue({ merged: true, prUrl: 'https://pr/1', conflict: false });
  mocks.serviceFindUnique.mockResolvedValue(null);
  mocks.hasDirtyWorkdir.mockResolvedValue(true);
  mocks.checkoutTaskBranch.mockResolvedValue(undefined);
  mocks.cloneRepository.mockResolvedValue({ emptyRepo: false });
  mocks.commitAndPush.mockResolvedValue(undefined);
  mocks.enqueueMergeGate.mockResolvedValue(undefined);
  mocks.queueDeployment.mockResolvedValue(undefined);
  mocks.persistTokenUsage.mockResolvedValue(undefined);
  mocks.cleanupWorkdir.mockResolvedValue(undefined);
  mocks.logEvent.mockResolvedValue(undefined);
  mocks.recordJobFailure.mockResolvedValue('recorded failure');
  mocks.publishTaskEvent.mockResolvedValue(undefined);
  mocks.setTaskStatus.mockResolvedValue(undefined);
  mocks.runHermesTask.mockResolvedValue(undefined);
  mocks.git.mockResolvedValue('');
});

afterEach(async () => {
  await fs.rm(mocks.config.AGENT_WORKDIR, { recursive: true, force: true });
});

describe('mergeGateTask entry guards', () => {
  it('logs an error and returns when the task does not exist', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mergeGateTask('task-1');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('task-1 not found'));
    expect(mocks.pullRequestChecksStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['status is no longer awaiting_review', { status: 'done' }],
    ['auto-merge is off', {}, false],
    ['the task has no branch', { branchName: null }],
  ])('does nothing when %s', async (_label, taskOverrides, autoMerge) => {
    const task = stubTask(taskOverrides as Record<string, unknown>);
    if (autoMerge === false) task.repository.autoMergePr = false;
    mocks.loadTaskWithRepo.mockResolvedValue(task);
    await mergeGateTask('task-1');
    expect(mocks.pullRequestChecksStatus).not.toHaveBeenCalled();
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });
});

describe('mergeGateTask pending CI (bounded self re-enqueue)', () => {
  it('re-enqueues itself with the delay and bumped attempt while CI runs', async () => {
    mocks.pullRequestChecksStatus.mockResolvedValue(pending);
    await mergeGateTask('task-1', 2, 1);
    expect(mocks.enqueueMergeGate).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 3, 1, MERGE_GATE_DELAY_MS);
    // Waiting must not burn an LLM runtime.
    expect(mocks.prepareAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
  });

  it('stops re-enqueueing after ~30 minutes of pending checks', async () => {
    mocks.pullRequestChecksStatus.mockResolvedValue(pending);
    await mergeGateTask('task-1', MERGE_GATE_MAX_ATTEMPTS, 0);
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('still running after ~30 minutes'),
    );
  });
});

describe('mergeGateTask failing CI', () => {
  it('runs the hermes CI fix and re-enqueues with ciFixes+1', async () => {
    mocks.config.AGENT_EXECUTOR = 'hermes';
    mocks.pullRequestChecksStatus.mockResolvedValue(failing);
    await mergeGateTask('task-1', 0, 1);

    expect(mocks.checkoutTaskBranch).toHaveBeenCalledWith(
      gateWorkdir(0, 1),
      'https://clone',
      'main',
      BRANCH,
      [],
      { headers: {} },
    );
    const opts = mocks.runHermesTask.mock.calls[0]?.[0];
    expect(opts.taskId).toBe('task-1');
    expect(opts.prompt).toContain('CI');
    expect(opts.prompt).toContain(BRANCH);
    expect(mocks.commitAndPush).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      expect.anything(),
      gateWorkdir(0, 1),
      'fix failing CI checks',
      ['push', 'origin', BRANCH],
      [],
      { headers: {} },
    );
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 1, 2, MERGE_GATE_DELAY_MS);
    expect(mocks.mergePullRequest).not.toHaveBeenCalled(); // never merge on red CI
  });

  it('gives up to manual after MAX_CI_FIX_ATTEMPTS fixes', async () => {
    mocks.config.AGENT_EXECUTOR = 'hermes';
    mocks.pullRequestChecksStatus.mockResolvedValue(failing);
    await mergeGateTask('task-1', 0, MAX_CI_FIX_ATTEMPTS);
    expect(mocks.runHermesTask).not.toHaveBeenCalled();
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining(`CI still failing after ${MAX_CI_FIX_ATTEMPTS} fix attempt(s)`),
    );
  });

  it('never CI-fixes on the internal executor — straight to manual', async () => {
    mocks.pullRequestChecksStatus.mockResolvedValue(failing);
    await mergeGateTask('task-1');
    expect(mocks.runHermesTask).not.toHaveBeenCalled();
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('CI checks are failing — awaiting manual fix'),
    );
  });
});

describe('mergeGateTask green CI', () => {
  it('merges exactly once, marks the task done, and releases the run workdir', async () => {
    await mergeGateTask('task-1');
    expect(mocks.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.mergePullRequest).toHaveBeenCalledWith(expect.anything(), {
      repoFullName: 'acme/widgets',
      headBranch: BRANCH,
      baseBranch: 'main',
    });
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'done');
    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith(
      path.join(mocks.config.AGENT_WORKDIR, 'task-1'),
      'task-1',
    );
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });

  it('queues a service deploy when the repository has one with autoDeploy on', async () => {
    mocks.serviceFindUnique.mockResolvedValue({ id: 'svc-1', name: 'web', autoDeploy: true });
    await mergeGateTask('task-1');
    expect(mocks.queueDeployment).toHaveBeenCalledWith('svc-1', 'task-1');
  });

  it('still merges when the deploy lookup fails — deploys never block a merge', async () => {
    mocks.serviceFindUnique.mockRejectedValue(new Error('db hiccup'));
    await mergeGateTask('task-1');
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'done');
    expect(mocks.recordJobFailure).not.toHaveBeenCalled();
  });

  it('merges unverified (with a log note) when the provider has no checks API', async () => {
    mocks.pullRequestChecksStatus.mockResolvedValue(unsupported);
    await mergeGateTask('task-1');
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('merging on the review verdict alone'),
    );
    expect(mocks.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('stops at manual when the provider refuses without a conflict', async () => {
    mocks.mergePullRequest.mockResolvedValue({ merged: false, conflict: false });
    await mergeGateTask('task-1');
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('manual review needed'),
    );
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });
});

describe('mergeGateTask conflict resolution (internal executor)', () => {
  beforeEach(() => {
    mocks.mergePullRequest.mockResolvedValue({ merged: false, conflict: true });
    mocks.git.mockImplementation(gitWithConflict());
    mocks.llmCall.mockResolvedValue(JSON.stringify({ content: 'resolved content' }));
  });

  it('resolves conflicts via the LLM, pushes, and re-enqueues to wait for CI', async () => {
    await seedConflictedWorkdir(gateWorkdir());
    await mergeGateTask('task-1');

    expect(mocks.cloneRepository).toHaveBeenCalledWith(
      gateWorkdir(),
      'https://clone',
      'main',
      [],
      { shallow: false, auth: { headers: {} } },
    );
    // The conflicted file was rewritten with the LLM-resolved content.
    const resolved = await fs.readFile(path.join(gateWorkdir(), 'src/a.ts'), 'utf8');
    expect(resolved).toBe('resolved content');
    expect(mocks.git).toHaveBeenCalledWith(
      ['push', 'origin', `HEAD:${BRANCH}`],
      expect.objectContaining({ cwd: gateWorkdir() }),
    );
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'diff', {
      path: 'src/a.ts',
      action: 'conflict-resolved',
    });
    // CI must pass on the resolution commit before the next merge attempt.
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 1, 0, MERGE_GATE_DELAY_MS);
    expect(mocks.mergePullRequest).toHaveBeenCalledTimes(1); // no second merge attempt in this job
  });

  it('treats an LLM resolution that keeps conflict markers as a retryable failure', async () => {
    await seedConflictedWorkdir(gateWorkdir());
    mocks.llmCall.mockResolvedValue(JSON.stringify({ content: CONFLICTED }));
    await expect(mergeGateTask('task-1')).rejects.toThrow(/conflict markers/);
    expect(mocks.recordJobFailure).toHaveBeenCalledWith(
      'merge-gate',
      'task-1',
      expect.any(Error),
      [],
    );
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
    expect(mocks.git).not.toHaveBeenCalledWith(
      expect.arrayContaining(['push']),
      expect.anything(),
    );
  });

  it('does not resolve conflicts once the attempt cap is reached — manual review', async () => {
    await mergeGateTask('task-1', MERGE_GATE_MAX_ATTEMPTS, 0);
    expect(mocks.cloneRepository).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('manual review needed'),
    );
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });
});

describe('mergeGateTask conflict resolution (hermes executor)', () => {
  beforeEach(() => {
    mocks.config.AGENT_EXECUTOR = 'hermes';
    mocks.mergePullRequest.mockResolvedValue({ merged: false, conflict: true });
    mocks.git.mockImplementation(gitWithConflict());
  });

  it('lets hermes rewrite conflicted files, then stages, commits, pushes, re-enqueues', async () => {
    await seedConflictedWorkdir(gateWorkdir());
    mocks.runHermesTask.mockImplementation(async (opts: { workdir: string }) => {
      await fs.writeFile(path.join(opts.workdir, 'src/a.ts'), 'hermes resolved');
    });
    await mergeGateTask('task-1');

    const opts = mocks.runHermesTask.mock.calls[0]?.[0];
    expect(opts.prompt).toContain('src/a.ts');
    expect(mocks.git).toHaveBeenCalledWith(['add', '--', 'src/a.ts'], { cwd: gateWorkdir() });
    expect(mocks.git).toHaveBeenCalledWith(['commit', '-m', 'resolve merge conflicts'], {
      cwd: gateWorkdir(),
    });
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 1, 0, MERGE_GATE_DELAY_MS);
  });

  it('refuses to push when hermes leaves conflict markers behind', async () => {
    await seedConflictedWorkdir(gateWorkdir());
    mocks.runHermesTask.mockImplementation(async () => {}); // markers stay in the file
    await expect(mergeGateTask('task-1')).rejects.toThrow(/conflict markers/);
    expect(mocks.recordJobFailure).toHaveBeenCalledWith(
      'merge-gate',
      'task-1',
      expect.any(Error),
      [],
    );
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });
});

describe('mergeGateTask failure path', () => {
  it('records and rethrows provider errors so BullMQ retries, and still cleans up', async () => {
    const boom = new Error('provider API down');
    mocks.pullRequestChecksStatus.mockRejectedValue(boom);
    await expect(mergeGateTask('task-1', 1, 2)).rejects.toBe(boom);
    expect(mocks.recordJobFailure).toHaveBeenCalledWith('merge-gate', 'task-1', boom, []);
    expect(mocks.persistTokenUsage).toHaveBeenCalledWith('task-1', 0, undefined);
    expect(mocks.cleanupWorkdir).toHaveBeenCalledWith(gateWorkdir(1, 2));
  });
});
