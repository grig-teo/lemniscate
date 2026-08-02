import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Task-level locking tests for mergeGateTask (merge-gate.ts): the pure
// decision table lives in tests/merge-gate.test.ts — here we pin everything
// the decision DRIVES: pending re-enqueue with attempt/ciFixes job identity,
// the hermes CI-fix path, the rebase-first stale-branch flow (internal LLM
// and hermes conflict resolution), the actual merge + deploy fan-out, and
// the record-then-rethrow failure path. Prisma, git, the queue, and
// providers are mocked; conflict files are real files in a tmp workdir so
// file rewrites are pinned too.

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
  hasMeaningfulChanges: vi.fn(),
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
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() },
}));

vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/lib/logger.js', () => ({
  logger: mocks.logger,
  createLogger: vi.fn(() => mocks.logger),
}));
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
vi.mock('../src/lib/workdir-changes.js', () => ({
  hasMeaningfulChanges: mocks.hasMeaningfulChanges,
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
// merge-gate notifies on merged/gave-up; the emitters pull in lib/crypto
// (ENCRYPTION_KEY absent from the partial config mock above). Notification
// fan-out is covered in notification-delivery.test.ts.
vi.mock('../src/lib/notifications.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  notifyOncePerTask: vi.fn().mockResolvedValue(undefined),
}));

// pr-review.js + conflict-resolve.js (parseResolvedFile, hasConflictMarkers,
// prompt builders) are intentionally NOT mocked: conflict-marker safety is
// behavior under test.
import {
  MAX_CI_FIX_ATTEMPTS,
  MAX_REBASE_RETRIES,
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

// Stale branch: the merge-base check fails and the rebase onto main stops
// with conflicts on src/a.ts; --continue succeeds after resolution.
function gitWithRebaseConflict(files = ['src/a.ts']) {
  return async (args: string[]) => {
    if (args[0] === 'merge-base') throw new Error('not an ancestor');
    if (args.includes('rebase') && !args.includes('--continue')) {
      throw new Error('CONFLICT (content)');
    }
    if (args[0] === 'diff') return `${files.join('\n')}\n`;
    return '';
  };
}

// Stale branch, clean rebase: merge-base check fails, the rebase applies
// without conflicts.
function gitStaleClean() {
  return async (args: string[]) => {
    if (args[0] === 'merge-base') throw new Error('not an ancestor');
    return '';
  };
}

function gitCalls(...verbs: string[]): string[][] {
  return mocks.git.mock.calls.filter((c) => verbs.some((v) => (c[0] as string[]).includes(v)));
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
  mocks.hasMeaningfulChanges.mockResolvedValue(true);
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
    expect(mocks.logger.error).toHaveBeenCalledWith(
      { taskId: 'task-1' },
      'merge-gate: task not found',
    );
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

describe('mergeGateTask waiting_ci re-checks', () => {
  it('accepts a waiting_ci task (the gate own wait/fix-ci state)', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(stubTask({ status: 'waiting_ci' }));
    await mergeGateTask('task-1');
    expect(mocks.pullRequestChecksStatus).toHaveBeenCalledTimes(1);
  });

  it('flips waiting_ci back to awaiting_review before merging on green CI', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(stubTask({ status: 'waiting_ci' }));
    await mergeGateTask('task-1');
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'done');
    expect(mocks.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting_ci while checks are still pending and re-enqueues', async () => {
    mocks.loadTaskWithRepo.mockResolvedValue(stubTask({ status: 'waiting_ci' }));
    mocks.pullRequestChecksStatus.mockResolvedValue(pending);
    await mergeGateTask('task-1', 1, 0);
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'waiting_ci');
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 2, 0, MERGE_GATE_DELAY_MS, 0);
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
  });
});

describe('mergeGateTask pending CI (bounded self re-enqueue)', () => {
  it('re-enqueues itself with the delay and bumped attempt while CI runs', async () => {
    mocks.pullRequestChecksStatus.mockResolvedValue(pending);
    await mergeGateTask('task-1', 2, 1);
    expect(mocks.enqueueMergeGate).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 3, 1, MERGE_GATE_DELAY_MS, 0);
    // Waiting must not burn an LLM runtime.
    expect(mocks.prepareAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
    // While CI runs the task shows waiting_ci.
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'waiting_ci');
  });

  it('stops re-enqueueing after ~30 minutes of pending checks', async () => {
    mocks.pullRequestChecksStatus.mockResolvedValue(pending);
    await mergeGateTask('task-1', MERGE_GATE_MAX_ATTEMPTS, 0);
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('still running after ~30 minutes'),
    );
    // The gate gave up: nothing re-triggers it, so the task must NOT park in
    // waiting_ci — it is awaiting_review so the user can still merge/close.
    expect(mocks.setTaskStatus).toHaveBeenCalledWith('task-1', 'awaiting_review');
    expect(mocks.setTaskStatus).not.toHaveBeenCalledWith('task-1', 'waiting_ci');
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
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 1, 2, MERGE_GATE_DELAY_MS, 0);
    expect(mocks.mergePullRequest).not.toHaveBeenCalled(); // never merge on red CI
  });

  it('rebases a stale branch instead of burning a CI-fix attempt on red CI', async () => {
    mocks.config.AGENT_EXECUTOR = 'hermes';
    mocks.pullRequestChecksStatus.mockResolvedValue(failing);
    // Stale: merge-base check fails; the rebase itself applies cleanly.
    mocks.git.mockImplementation(async (args: string[]) => {
      if (args[0] === 'merge-base') throw new Error('not an ancestor');
      return '';
    });
    await mergeGateTask('task-1', 0, 1);

    // No hermes CI fix on a stale branch — the rebase IS the fix attempt.
    expect(mocks.runHermesTask).not.toHaveBeenCalled();
    expect(mocks.commitAndPush).not.toHaveBeenCalled();
    const pushes = mocks.git.mock.calls.filter((c) => (c[0] as string[]).includes('push'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0][0]).toEqual(['push', '--force-with-lease', 'origin', `HEAD:${BRANCH}`]);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('rebasing the task branch onto it before diagnosing further'),
    );
    // Re-enqueued WITHOUT consuming a ciFix — the rebase is not a fix attempt.
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 1, 1, MERGE_GATE_DELAY_MS, 0);
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
  });

  it('forces a rebase retry with a fresh fix budget after MAX_CI_FIX_ATTEMPTS fixes', async () => {
    mocks.config.AGENT_EXECUTOR = 'hermes';
    mocks.pullRequestChecksStatus.mockResolvedValue(failing);
    mocks.git.mockImplementation(async (args: string[]) => {
      if (args[0] === 'merge-base') throw new Error('not an ancestor');
      return '';
    });
    await mergeGateTask('task-1', 0, MAX_CI_FIX_ATTEMPTS);
    expect(mocks.runHermesTask).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('rebasing onto main and retrying with a fresh fix budget'),
    );
    // ciFixes reset to 0, the single rebase retry consumed.
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 1, 0, MERGE_GATE_DELAY_MS, 1);
  });

  it('gives up to manual only after the rebase retry is spent', async () => {
    mocks.config.AGENT_EXECUTOR = 'hermes';
    mocks.pullRequestChecksStatus.mockResolvedValue(failing);
    await mergeGateTask('task-1', 0, MAX_CI_FIX_ATTEMPTS, MAX_REBASE_RETRIES);
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
    // Up-to-date branch (default git mock: merge-base passes) — no rebase,
    // no force push: the provider merge is the only git-level action.
    expect(gitCalls('rebase')).toHaveLength(0);
    expect(gitCalls('push')).toHaveLength(0);
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

describe('mergeGateTask rebase of a stale branch (internal executor)', () => {
  beforeEach(() => {
    mocks.git.mockImplementation(gitWithRebaseConflict());
    mocks.llmCall.mockResolvedValue(JSON.stringify({ content: 'resolved content' }));
  });

  it('rebases onto main, resolves conflicts via the LLM, force-pushes, and re-enqueues to wait for CI', async () => {
    await seedConflictedWorkdir(gateWorkdir());
    await mergeGateTask('task-1');

    expect(mocks.cloneRepository).toHaveBeenCalledWith(
      gateWorkdir(),
      'https://clone',
      'main',
      [],
      { shallow: false, auth: { headers: {} } },
    );
    // No provider merge this round: CI must pass on the rebased head first.
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
    // The branch was checked out and rebased onto main.
    expect(gitCalls('checkout')[0][0]).toEqual(['checkout', '-b', 'lemniscate-rebase', 'FETCH_HEAD']);
    expect(gitCalls('rebase').some((c) => (c[0] as string[]).includes('main'))).toBe(true);
    // The conflicted file was rewritten with the LLM-resolved content and
    // the rebase continued non-interactively.
    const resolved = await fs.readFile(path.join(gateWorkdir(), 'src/a.ts'), 'utf8');
    expect(resolved).toBe('resolved content');
    const continues = gitCalls('rebase').filter((c) => (c[0] as string[]).includes('--continue'));
    expect(continues).toHaveLength(1);
    expect(continues[0][0]).toContain('core.editor=true');
    // The rebased (linear) branch goes back over the PR head with a lease.
    expect(mocks.git).toHaveBeenCalledWith(
      ['push', '--force-with-lease', 'origin', `HEAD:${BRANCH}`],
      expect.objectContaining({ cwd: gateWorkdir() }),
    );
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'diff', {
      path: 'src/a.ts',
      action: 'conflict-resolved',
    });
    // CI must pass on the rebased head before the next merge attempt.
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 1, 0, MERGE_GATE_DELAY_MS, 0);
  });

  it('rebases without any LLM calls when the rebase applies cleanly', async () => {
    mocks.git.mockImplementation(gitStaleClean());
    await mergeGateTask('task-1');
    expect(mocks.mergePullRequest).not.toHaveBeenCalled();
    expect(mocks.llmCall).not.toHaveBeenCalled();
    expect(gitCalls('push')).toHaveLength(1);
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 1, 0, MERGE_GATE_DELAY_MS, 0);
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

  it('does not rebase once the attempt cap is reached — manual review', async () => {
    await mergeGateTask('task-1', MERGE_GATE_MAX_ATTEMPTS, 0);
    expect(gitCalls('rebase')).toHaveLength(0);
    expect(gitCalls('push')).toHaveLength(0);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('manual review needed'),
    );
    expect(mocks.enqueueMergeGate).not.toHaveBeenCalled();
  });

  it('rebases when the provider reports a conflict despite an up-to-date local check (race)', async () => {
    // Up-to-date branch: merge-base passes, so the provider merge is
    // attempted — but main moved in between and it conflicts.
    mocks.git.mockImplementation(async () => '');
    mocks.mergePullRequest.mockResolvedValue({ merged: false, conflict: true });
    await mergeGateTask('task-1');
    expect(mocks.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(gitCalls('checkout')).toHaveLength(1);
    expect(gitCalls('push')).toHaveLength(1);
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 1, 0, MERGE_GATE_DELAY_MS, 0);
  });
});

describe('mergeGateTask rebase of a stale branch (hermes executor)', () => {
  beforeEach(() => {
    mocks.config.AGENT_EXECUTOR = 'hermes';
    mocks.git.mockImplementation(gitWithRebaseConflict());
  });

  it('lets hermes rewrite conflicted files, then stages, continues the rebase, force-pushes, re-enqueues', async () => {
    await seedConflictedWorkdir(gateWorkdir());
    mocks.runHermesTask.mockImplementation(async (opts: { workdir: string }) => {
      await fs.writeFile(path.join(opts.workdir, 'src/a.ts'), 'hermes resolved');
    });
    await mergeGateTask('task-1');

    const opts = mocks.runHermesTask.mock.calls[0]?.[0];
    expect(opts.prompt).toContain('src/a.ts');
    expect(mocks.git).toHaveBeenCalledWith(['add', '--', 'src/a.ts'], { cwd: gateWorkdir() });
    const continues = gitCalls('rebase').filter((c) => (c[0] as string[]).includes('--continue'));
    expect(continues).toHaveLength(1);
    expect(mocks.git).toHaveBeenCalledWith(
      ['push', '--force-with-lease', 'origin', `HEAD:${BRANCH}`],
      expect.objectContaining({ cwd: gateWorkdir() }),
    );
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith('task-1', 1, 0, MERGE_GATE_DELAY_MS, 0);
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
    expect(mocks.git).not.toHaveBeenCalledWith(
      expect.arrayContaining(['push']),
      expect.anything(),
    );
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
