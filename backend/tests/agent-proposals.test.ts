import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository, GitConnection } from '@prisma/client';

// Tests for the 'generate-proposals' job: the LLM's proposals (up to 5)
// become pending proposal tasks (click-to-run, not auto-enqueued), deduped
// by title against pending/queued ones and topped up to at most 5 pending.
// All I/O collaborators are mocked — no DB, Redis, git, or LLM is contacted.

const mocks = vi.hoisted(() => ({
  repositoryFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  taskCreate: vi.fn(),
  enqueueRunTask: vi.fn(),
  requestProposals: vi.fn(),
  prepareAgentRuntime: vi.fn(),
  cloneRepository: vi.fn(),
  cleanupWorkdir: vi.fn(),
  buildRepoContext: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    repository: { findUnique: mocks.repositoryFindUnique },
    task: { findMany: mocks.taskFindMany, create: mocks.taskCreate },
  },
}));
vi.mock('../src/lib/agent-runtime.js', () => ({
  prepareAgentRuntime: mocks.prepareAgentRuntime,
}));
vi.mock('../src/lib/agent-git.js', () => ({
  cloneRepository: mocks.cloneRepository,
  cleanupWorkdir: mocks.cleanupWorkdir,
}));
vi.mock('../src/lib/repo-context.js', () => ({ buildRepoContext: mocks.buildRepoContext }));
vi.mock('../src/lib/agent-prompts.js', () => ({ requestProposals: mocks.requestProposals }));
vi.mock('../src/lib/proposal-scheduler.js', () => ({ enqueueRunTask: mocks.enqueueRunTask }));

import { generateProposals } from '../src/lib/agent-proposals.js';

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

function stubHappyPath(proposals: Array<{ title: string; prompt: string }>): void {
  mocks.repositoryFindUnique.mockResolvedValue(stubRepository());
  mocks.prepareAgentRuntime.mockResolvedValue({
    cloneUrl: 'https://example/repo.git',
    rt: { cfg: { contextWindow: 1000, systemPromptExtra: null } },
  });
  mocks.buildRepoContext.mockResolvedValue('CTX');
  mocks.requestProposals.mockResolvedValue(proposals);
  mocks.taskCreate.mockImplementation((args: { data: { title: string } }) =>
    Promise.resolve({ id: `task-${args.data.title}` }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskFindMany.mockResolvedValue([]);
});

describe('generateProposals', () => {
  it('creates pending tasks for up to 5 proposals without enqueueing', async () => {
    stubHappyPath([1, 2, 3, 4, 5].map(proposal));
    await generateProposals('repo-1');
    expect(mocks.taskCreate).toHaveBeenCalledTimes(5);
    expect(mocks.taskCreate.mock.calls[0]?.[0].data.status).toBe('pending');
    expect(mocks.enqueueRunTask).not.toHaveBeenCalled();
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

  it('skips cleanly when the repository is empty (clone finds no branch)', async () => {
    stubHappyPath([proposal(1)]);
    mocks.taskFindMany.mockResolvedValue([]);
    mocks.cloneRepository.mockRejectedValueOnce(
      new Error('git clone failed: fatal: Remote branch master not found in upstream origin'),
    );
    await expect(generateProposals('repo-1')).resolves.toBeUndefined();
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
});
