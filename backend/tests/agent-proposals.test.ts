import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository, GitConnection } from '@prisma/client';

// Tests for the 'generate-proposals' job: the lemcore agent explores the
// clone and writes .lemniscate-proposals.json; the parsed proposals (up to 5)
// become pending proposal tasks (click-to-run, not auto-enqueued), deduped by
// title against pending/queued/running ones and topped up to at most 5
// pending. All I/O collaborators are mocked — no DB, Redis, git, or LLM is
// contacted.

const mocks = vi.hoisted(() => ({
  config: {
    AGENT_WORKDIR: '/tmp/test-workdirs',
    AGENT_HERMES_TIMEOUT_MINUTES: 45,
  },
  repositoryFindUnique: vi.fn(),
  repositoryUpdate: vi.fn(),
  taskFindMany: vi.fn(),
  taskCreate: vi.fn(),
  skillFindMany: vi.fn(),
  prepareAgentRuntime: vi.fn(),
  cloneRepository: vi.fn(),
  cleanupWorkdir: vi.fn(),
  resolveAgentExecutor: vi.fn(),
  runLemcoreTask: vi.fn(),
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
vi.mock('../src/lib/agent-executor.js', () => ({
  resolveAgentExecutor: mocks.resolveAgentExecutor,
}));
vi.mock('../src/lib/lemcore/run.js', () => ({ runLemcoreTask: mocks.runLemcoreTask }));
// Keep the real prompt builders + proposals schema (the pure helpers under
// test use them).

import {
  buildLemcoreProposalPrompt,
  generateProposals,
  parseProposalsFile,
  pendingProposalState,
  sortByPriority,
  stampProposalFailure,
  stampProposalSuccess,
} from '../src/lib/agent-proposals.js';

type RepositoryWithConnection = Repository & { connection: GitConnection };

const PROPOSALS_FILENAME = '.lemniscate-proposals.json';

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
    skillSlugs: [],
    connection: { userId: 'user-1' },
  } as unknown as RepositoryWithConnection;
}

function stubHappyPath(
  proposals: Array<{ title: string; prompt: string; category?: string; priority?: string; effort?: string }>,
): void {
  mocks.repositoryFindUnique.mockResolvedValue(stubRepository());
  mocks.prepareAgentRuntime.mockResolvedValue({
    cloneUrl: 'https://example/repo.git',
    gitAuth: { username: 'oauth', token: 'tok' },
    rt: { cfg: { contextWindow: 1000, systemPromptExtra: null } },
  });
  mocks.skillFindMany.mockResolvedValue([]);
  lemcoreWritesFile(JSON.stringify(proposals));
  mocks.taskCreate.mockImplementation((args: { data: { title: string } }) =>
    Promise.resolve({ id: `task-${args.data.title}` }),
  );
}

function lemcoreWritesFile(content: string): void {
  mocks.runLemcoreTask.mockImplementation(async (opts: { workdir: string }) => {
    await fs.mkdir(opts.workdir, { recursive: true });
    await fs.writeFile(path.join(opts.workdir, PROPOSALS_FILENAME), content);
    return { summary: null, changed: true };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentExecutor.mockResolvedValue('lemcore');
  mocks.taskFindMany.mockResolvedValue([]);
});

afterEach(async () => {
  await fs.rm(mocks.config.AGENT_WORKDIR, { recursive: true, force: true });
});

describe('generateProposals', () => {
  it('creates pending tasks for up to 5 proposals', async () => {
    stubHappyPath([1, 2, 3, 4, 5].map(proposal));
    await generateProposals('repo-1');
    expect(mocks.taskCreate).toHaveBeenCalledTimes(5);
    for (const call of mocks.taskCreate.mock.calls) {
      expect(call[0].data.status).toBe('pending');
    }
  });

  it('persists the proposal category, priority, and effort on the created task', async () => {
    stubHappyPath([
      { title: 'Fix XSS', prompt: 'Escape output', category: 'security', priority: 'critical', effort: 'small' },
    ]);
    await generateProposals('repo-1');
    expect(mocks.taskCreate.mock.calls[0]?.[0].data).toMatchObject({
      kind: 'proposal',
      category: 'security',
      priority: 'critical',
      effort: 'small',
    });
  });

  it('creates proposals sequentially, lowest priority first (critical gets the newest createdAt)', async () => {
    stubHappyPath([
      { title: 'Low one', prompt: 'P', priority: 'low' },
      { title: 'Critical one', prompt: 'P', priority: 'critical' },
      { title: 'High one', prompt: 'P', priority: 'high' },
    ]);
    await generateProposals('repo-1');
    expect(mocks.taskCreate).toHaveBeenCalledTimes(3);
    const titles = mocks.taskCreate.mock.calls.map((call) => call[0].data.title);
    expect(titles).toEqual(['Low one', 'High one', 'Critical one']);
  });

  it('inherits the repository LLM config and skill slugs on the proposal tasks', async () => {
    stubHappyPath([proposal(1)]);
    mocks.repositoryFindUnique.mockResolvedValue({
      ...stubRepository(),
      llmConfigId: 'llm-9',
      skillSlugs: ['skill-a'],
    });
    await generateProposals('repo-1');
    expect(mocks.taskCreate.mock.calls[0]?.[0].data).toMatchObject({
      llmConfigId: 'llm-9',
      skills: ['skill-a'],
    });
  });

  it('omits llmConfigId when the repository has none', async () => {
    stubHappyPath([proposal(1)]);
    await generateProposals('repo-1');
    expect(mocks.taskCreate.mock.calls[0]?.[0].data.llmConfigId).toBeUndefined();
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
    mocks.repositoryFindUnique.mockResolvedValue(stubRepository());
    mocks.taskFindMany.mockResolvedValue(
      [1, 2, 3, 4, 5].map((i) => ({ title: `Old ${i}`, status: 'pending' })),
    );
    await generateProposals('repo-1');
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it('propagates clone failures', async () => {
    stubHappyPath([proposal(1)]);
    mocks.taskFindMany.mockResolvedValue([]);
    mocks.cloneRepository.mockRejectedValueOnce(new Error('git clone failed: boom'));
    await expect(generateProposals('repo-1')).rejects.toThrow('git clone failed: boom');
    expect(mocks.runLemcoreTask).not.toHaveBeenCalled();
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it('exits before cloning or running the agent when 5 proposals are pending', async () => {
    mocks.repositoryFindUnique.mockResolvedValue(stubRepository());
    mocks.taskFindMany.mockResolvedValue(
      [1, 2, 3, 4, 5].map((i) => ({ title: `Old ${i}`, status: 'pending' })),
    );
    await generateProposals('repo-1');
    expect(mocks.prepareAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.cloneRepository).not.toHaveBeenCalled();
    expect(mocks.runLemcoreTask).not.toHaveBeenCalled();
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it('generates even when autoPropose is off (manual round-button trigger)', async () => {
    stubHappyPath([proposal(1)]);
    mocks.repositoryFindUnique.mockResolvedValue({ ...stubRepository(), autoPropose: false });
    mocks.taskFindMany.mockResolvedValue([]);
    await generateProposals('repo-1');
    expect(mocks.runLemcoreTask).toHaveBeenCalled();
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

  it('fails when lemcore writes no usable proposals file', async () => {
    stubHappyPath([proposal(1)]);
    mocks.runLemcoreTask.mockResolvedValue({ summary: null, changed: false });
    await expect(generateProposals('repo-1')).rejects.toThrow('no usable proposals file');
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it('fails when the proposals file is invalid JSON', async () => {
    stubHappyPath([proposal(1)]);
    lemcoreWritesFile('the agent wrote prose instead');
    await expect(generateProposals('repo-1')).rejects.toThrow('no usable proposals file');
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-lemcore executor resolution', async () => {
    stubHappyPath([proposal(1)]);
    mocks.resolveAgentExecutor.mockResolvedValue('hermes');
    await expect(generateProposals('repo-1')).rejects.toThrow('unsupported executor');
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it('passes the repository skills into the lemcore prompt', async () => {
    stubHappyPath([proposal(1)]);
    mocks.repositoryFindUnique.mockResolvedValue({
      ...stubRepository(),
      skillSlugs: ['skill-a'],
    });
    mocks.skillFindMany.mockResolvedValue([
      { name: 'Skill A', slug: 'skill-a', content: 'Do things well' },
    ]);
    await generateProposals('repo-1');
    const call = mocks.runLemcoreTask.mock.calls[0]?.[0];
    expect(call.promptOverride).toContain('### Skill A (skill-a)');
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

describe('parseProposalsFile', () => {
  it('parses a bare JSON array', () => {
    expect(parseProposalsFile('[{"title":"T","prompt":"P"}]')).toEqual([
      { title: 'T', prompt: 'P', category: 'code quality', priority: 'medium', effort: 'medium' },
    ]);
  });

  it('parses JSON embedded in surrounding prose', () => {
    const raw = 'Here are the proposals:\n[{"title":"T","prompt":"P"}]\nDone.';
    expect(parseProposalsFile(raw)).toEqual([
      { title: 'T', prompt: 'P', category: 'code quality', priority: 'medium', effort: 'medium' },
    ]);
  });

  it('returns null for malformed JSON or schema mismatches', () => {
    expect(parseProposalsFile('not json at all')).toBeNull();
    expect(parseProposalsFile('[{"title":"T"}]')).toBeNull();
    expect(parseProposalsFile('{"title":"T","prompt":"P"}')).toBeNull();
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

describe('buildLemcoreProposalPrompt', () => {
  it('includes the skills section and owner instructions when provided', () => {
    const prompt = buildLemcoreProposalPrompt({
      fullName: 'owner/repo',
      defaultBranch: 'main',
      systemPromptExtra: 'Focus on tests.',
      repoContext: '',
      skillsSection: '## Active skills\n\n### Skill A (skill-a)\nDo things well',
    });
    expect(prompt).toContain('.lemniscate-proposals.json');
    expect(prompt).toContain('owner/repo');
    expect(prompt).toContain('"priority": "critical"|"high"|"medium"|"low"');
    expect(prompt).toContain('### Skill A (skill-a)');
    expect(prompt).toContain('Focus on tests.');
    expect(prompt).toContain('Do NOT');
  });

  it('omits empty extras', () => {
    const prompt = buildLemcoreProposalPrompt({
      fullName: 'owner/repo',
      defaultBranch: 'main',
      systemPromptExtra: null,
      repoContext: '',
      skillsSection: '',
    });
    expect(prompt).not.toContain('Additional instructions');
    expect(prompt).not.toContain('Active skills');
  });

  it('requires features proposals for new implementations', () => {
    const prompt = buildLemcoreProposalPrompt({
      fullName: 'owner/repo',
      defaultBranch: 'main',
      systemPromptExtra: null,
      repoContext: '',
      skillsSection: '',
    });
    expect(prompt).toContain('features');
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
