import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository, GitConnection } from '@prisma/client';

// Tests for the 'generate-proposals' job: the LLM's proposals (up to 5)
// become pending proposal tasks (click-to-run, not auto-enqueued), deduped
// by title against pending/queued ones and topped up to at most 5 pending.
// All I/O collaborators are mocked — no DB, Redis, git, or LLM is contacted.

const mocks = vi.hoisted(() => ({
  config: {
    AGENT_WORKDIR: '/tmp/test-workdirs',
  },
  repositoryFindUnique: vi.fn(),
  repositoryUpdate: vi.fn(),
  taskFindMany: vi.fn(),
  taskCreate: vi.fn(),
  skillFindMany: vi.fn(),
  enqueueRunTask: vi.fn(),
  requestProposals: vi.fn(),
  prepareAgentRuntime: vi.fn(),
  cloneRepository: vi.fn(),
  cleanupWorkdir: vi.fn(),
  buildRepoContext: vi.fn(),
}));

vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    repository: { findUnique: mocks.repositoryFindUnique, update: mocks.repositoryUpdate },
    task: { findMany: mocks.taskFindMany, create: mocks.taskCreate },
    skill: { findMany: mocks.skillFindMany },
  },
}));
vi.mock('../src/lib/agent-runtime.js', () => ({
  prepareAgentRuntime: mocks.prepareAgentRuntime,
}));
vi.mock('../src/lib/agent-git.js', () => ({
  cloneRepository: mocks.cloneRepository,
  cleanupWorkdir: mocks.cleanupWorkdir,
}));
vi.mock('../src/lib/repo-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/repo-context.js')>()),
  buildRepoContext: mocks.buildRepoContext,
}));
// Keep the real prompt builders + proposals schema (the pure helpers under
// test use them); only the network-bound requestProposals is stubbed.
vi.mock('../src/lib/agent-prompts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agent-prompts.js')>()),
  requestProposals: mocks.requestProposals,
}));
vi.mock('../src/lib/proposal-scheduler.js', () => ({ enqueueRunTask: mocks.enqueueRunTask }));

import {
  generateProposals,
  pendingProposalState,
  sortByPriority,
  stampProposalFailure,
  stampProposalSuccess,
} from '../src/lib/agent-proposals.js';

type RepositoryWithConnection = Repository & { connection: GitConnection };

function proposal(index: number) {
  return { title: `Proposal ${index}`, prompt: `Do thing ${index}` };
}

function stubRepository(): RepositoryWithConnection {
  return {
    id: 'repo-1',
    fullName: 'owner/repo',
    autoPropose: true,
    defaultBranch: 'main',
    llmConfigId: null,
    connection: {},
  } as unknown as RepositoryWithConnection;
}

function stubHappyPath(
  proposals: Array<{ title: string; prompt: string; category?: string; priority?: string; effort?: string }>,
): void {
  mocks.repositoryFindUnique.mockResolvedValue(stubRepository());
  mocks.prepareAgentRuntime.mockResolvedValue({
    cloneUrl: 'https://example/repo.git',
    rt: { cfg: { contextWindow: 1000, systemPromptExtra: null } },
  });
  mocks.buildRepoContext.mockResolvedValue({ text: 'CTX', files: [] });
  mocks.requestProposals.mockResolvedValue(proposals);
  mocks.taskCreate.mockImplementation((args: { data: { title: string } }) =>
    Promise.resolve({ id: `task-${args.data.title}` }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskFindMany.mockResolvedValue([]);
});

afterEach(async () => {
  await fs.rm(mocks.config.AGENT_WORKDIR, { recursive: true, force: true });
});

describe('generateProposals', () => {
  it('creates pending tasks for up to 5 proposals without enqueueing', async () => {
    stubHappyPath([1, 2, 3, 4, 5].map(proposal));
    await generateProposals('repo-1');
    expect(mocks.taskCreate).toHaveBeenCalledTimes(5);
    expect(mocks.taskCreate.mock.calls[0]?.[0].data.status).toBe('pending');
    expect(mocks.enqueueRunTask).not.toHaveBeenCalled();
  });

  it('persists the proposal category, priority, and effort on the created task', async () => {
    stubHappyPath([
      { title: 'Fix XSS', prompt: 'Escape output', category: 'security', priority: 'critical', effort: 'small' },
    ]);
    await generateProposals('repo-1');
    expect(mocks.taskCreate.mock.calls[0]?.[0].data).toMatchObject({
      category: 'security',
      priority: 'critical',
      effort: 'small',
    });
  });

  it('persists a features proposal as a pending task with category features', async () => {
    stubHappyPath([
      { title: 'Add REST webhooks', prompt: 'Implement outbound webhooks', category: 'features', priority: 'high', effort: 'medium' },
    ]);
    await generateProposals('repo-1');
    expect(mocks.taskCreate.mock.calls[0]?.[0].data).toMatchObject({
      kind: 'proposal',
      category: 'features',
      priority: 'high',
      effort: 'medium',
      status: 'pending',
    });
  });

  it('skips proposals whose title is already pending or queued', async () => {
    stubHappyPath([proposal(1), proposal(2)]);
    mocks.taskFindMany.mockResolvedValue([{ title: '  proposal 1 ', status: 'queued' }]);
    await generateProposals('repo-1');
    expect(mocks.taskCreate).toHaveBeenCalledTimes(1);
    expect(mocks.taskCreate.mock.calls[0]?.[0].data.title).toBe('Proposal 2');
  });

  it('tops up to 5 pending: 2 pending + 5 generated creates only 3', async () => {
    stubHappyPath([1, 2, 3, 4, 5].map(proposal));
    mocks.taskFindMany.mockResolvedValue([
      { title: 'Old 1', status: 'pending' },
      { title: 'Old 2', status: 'pending' },
    ]);
    await generateProposals('repo-1');
    expect(mocks.taskCreate).toHaveBeenCalledTimes(3);
  });

  it('creates nothing when 5 proposals are already pending', async () => {
    stubHappyPath([1, 2, 3].map(proposal));
    mocks.taskFindMany.mockResolvedValue(
      [1, 2, 3, 4, 5].map((i) => ({ title: `Old ${i}`, status: 'pending' })),
    );
    await generateProposals('repo-1');
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it('propagates clone failures (empty-repo handling lives in cloneRepository)', async () => {
    stubHappyPath([proposal(1)]);
    mocks.taskFindMany.mockResolvedValue([]);
    mocks.cloneRepository.mockRejectedValueOnce(new Error('git clone failed: boom'));
    await expect(generateProposals('repo-1')).rejects.toThrow('git clone failed: boom');
    expect(mocks.requestProposals).not.toHaveBeenCalled();
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it('exits before cloning or calling the LLM when 5 proposals are pending', async () => {
    mocks.repositoryFindUnique.mockResolvedValue(stubRepository());
    mocks.taskFindMany.mockResolvedValue(
      [1, 2, 3, 4, 5].map((i) => ({ title: `Old ${i}`, status: 'pending' })),
    );
    await generateProposals('repo-1');
    expect(mocks.prepareAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.cloneRepository).not.toHaveBeenCalled();
    expect(mocks.requestProposals).not.toHaveBeenCalled();
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it('generates even when autoPropose is off (manual round-button trigger)', async () => {
    stubHappyPath([proposal(1)]);
    mocks.repositoryFindUnique.mockResolvedValue({ ...stubRepository(), autoPropose: false });
    mocks.taskFindMany.mockResolvedValue([]);
    await generateProposals('repo-1');
    expect(mocks.requestProposals).toHaveBeenCalled();
    expect(mocks.taskCreate).toHaveBeenCalledTimes(1);
  });

  it('does not re-propose an archived title, but archived pendings do not fill the cap', async () => {
    stubHappyPath([proposal(1), proposal(2)]);
    mocks.taskFindMany.mockResolvedValue([
      { title: 'Proposal 1', status: 'pending', archivedAt: new Date() },
    ]);
    await generateProposals('repo-1');
    expect(mocks.taskCreate).toHaveBeenCalledTimes(1);
    expect(mocks.taskCreate.mock.calls[0]?.[0].data.title).toBe('Proposal 2');
  });

  it('does not bail early when the 5 pending proposals are all archived', async () => {
    stubHappyPath([proposal(1)]);
    mocks.taskFindMany.mockResolvedValue(
      [1, 2, 3, 4, 5].map((i) => ({ title: `Old ${i}`, status: 'pending', archivedAt: new Date() })),
    );
    await generateProposals('repo-1');
    expect(mocks.prepareAgentRuntime).toHaveBeenCalled();
    expect(mocks.taskCreate).toHaveBeenCalledTimes(1);
  });
});

// Archived pending proposals keep their title in the dedupe set (don't
// re-propose what the user archived) but do not count toward the top-up cap.
describe('pendingProposalState', () => {
  it('counts only non-archived pending rows while keeping all titles', () => {
    const state = pendingProposalState([
      { title: ' Active ', status: 'pending', archivedAt: null },
      { title: 'Archived', status: 'pending', archivedAt: new Date() },
      { title: 'Queued', status: 'queued', archivedAt: null },
    ]);
    expect(state.pendingCount).toBe(1);
    expect(state.titles).toEqual(new Set(['active', 'archived', 'queued']));
  });

  it('treats rows without archivedAt as not archived', () => {
    const state = pendingProposalState([{ title: 'T', status: 'pending' }]);
    expect(state.pendingCount).toBe(1);
  });
});

describe('sortByPriority', () => {
  it('orders critical first and keeps the input array unchanged', () => {
    const input = [
      { title: 'L', prompt: 'P', category: 'seo' as const, priority: 'low' as const, effort: 'small' as const },
      { title: 'C', prompt: 'P', category: 'security' as const, priority: 'critical' as const, effort: 'small' as const },
      { title: 'H', prompt: 'P', category: 'bug fix' as const, priority: 'high' as const, effort: 'medium' as const },
    ];
    const sorted = sortByPriority(input);
    expect(sorted.map((p) => p.priority)).toEqual(['critical', 'high', 'low']);
    expect(input[0]?.priority).toBe('low');
  });
});

// Pipeline-health stamping: the worker handler calls these after each
// generate-proposals outcome to update the Repository row's health columns.
// stampProposalSuccess sets lastProposalAt and clears lastProposalError;
// stampProposalFailure sets lastProposalError (truncated to 500 chars).
describe('stampProposalSuccess', () => {
  beforeEach(() => {
    mocks.repositoryUpdate.mockResolvedValue(undefined);
  });

  it('sets lastProposalAt to now and clears lastProposalError', async () => {
    await stampProposalSuccess('repo-1');
    expect(mocks.repositoryUpdate).toHaveBeenCalledWith({
      where: { id: 'repo-1' },
      data: { lastProposalAt: expect.any(Date), lastProposalError: null },
    });
  });
});

describe('stampProposalFailure', () => {
  beforeEach(() => {
    mocks.repositoryUpdate.mockResolvedValue(undefined);
  });

  it('sets lastProposalError with the error message', async () => {
    await stampProposalFailure('repo-1', 'LLM connection refused');
    expect(mocks.repositoryUpdate).toHaveBeenCalledWith({
      where: { id: 'repo-1' },
      data: { lastProposalError: 'LLM connection refused' },
    });
  });

  it('truncates very long error messages to 500 characters', async () => {
    const longMessage = 'x'.repeat(600);
    await stampProposalFailure('repo-1', longMessage);
    const stamped = mocks.repositoryUpdate.mock.calls[0]?.[0].data.lastProposalError as string;
    expect(stamped).toHaveLength(500);
    expect(stamped).toBe('x'.repeat(500));
  });
});
