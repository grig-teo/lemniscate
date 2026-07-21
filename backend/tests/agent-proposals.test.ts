import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository, GitConnection } from '@prisma/client';

// Tests for the 'generate-proposals' job: the LLM's proposals (up to 5)
// become pending proposal tasks (click-to-run, not auto-enqueued), deduped
// by title against pending/queued ones and topped up to at most 5 pending.
// All I/O collaborators are mocked — no DB, Redis, git, or LLM is contacted.

const mocks = vi.hoisted(() => ({
  config: {
    AGENT_EXECUTOR: 'internal' as string,
    AGENT_WORKDIR: '/tmp/test-workdirs',
    AGENT_HERMES_TIMEOUT_MINUTES: 45,
  },
  repositoryFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  taskCreate: vi.fn(),
  skillFindMany: vi.fn(),
  enqueueRunTask: vi.fn(),
  requestProposals: vi.fn(),
  prepareAgentRuntime: vi.fn(),
  cloneRepository: vi.fn(),
  cleanupWorkdir: vi.fn(),
  buildRepoContext: vi.fn(),
  runHermesTask: vi.fn(),
}));

vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    repository: { findUnique: mocks.repositoryFindUnique },
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
vi.mock('../src/lib/hermes-runner.js', () => ({ runHermesTask: mocks.runHermesTask }));
vi.mock('../src/lib/proposal-scheduler.js', () => ({ enqueueRunTask: mocks.enqueueRunTask }));

import {
  buildHermesProposalPrompt,
  generateProposals,
  parseProposalsFile,
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

function stubHappyPath(proposals: Array<{ title: string; prompt: string }>): void {
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
  mocks.config.AGENT_EXECUTOR = 'internal';
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
});

// AGENT_EXECUTOR=hermes: the hermes agent explores the clone and writes
// .lemniscate-proposals.json; a missing/invalid file falls back to the
// direct LLM request so the top-up still works.
describe('generateProposals with AGENT_EXECUTOR=hermes', () => {
  function stubHermesPath(): void {
    mocks.config.AGENT_EXECUTOR = 'hermes';
    mocks.repositoryFindUnique.mockResolvedValue({
      ...stubRepository(),
      skillSlugs: ['skill-a'],
    });
    mocks.prepareAgentRuntime.mockResolvedValue({
      cloneUrl: 'https://example/repo.git',
      rt: {
        apiKey: 'sk-test',
        cfg: {
          baseUrl: 'https://llm.example/v1',
          model: 'model-x',
          contextWindow: 128_000,
          systemPromptExtra: 'Focus on tests.',
        },
      },
    });
    mocks.buildRepoContext.mockResolvedValue({ text: 'CTX', files: [] });
    mocks.skillFindMany.mockResolvedValue([
      { name: 'Skill A', slug: 'skill-a', content: 'Do things well' },
    ]);
    mocks.taskCreate.mockImplementation((args: { data: { title: string } }) =>
      Promise.resolve({ id: `task-${args.data.title}` }),
    );
  }

  function hermesWritesFile(content: string): void {
    mocks.runHermesTask.mockImplementation(async (opts: { workdir: string }) => {
      await fs.mkdir(opts.workdir, { recursive: true });
      await fs.writeFile(path.join(opts.workdir, '.lemniscate-proposals.json'), content);
    });
  }

  it('runs hermes without a taskId and creates proposals from the written file', async () => {
    stubHermesPath();
    hermesWritesFile(JSON.stringify([proposal(1), proposal(2)]));
    await generateProposals('repo-1');

    expect(mocks.runHermesTask).toHaveBeenCalledTimes(1);
    const call = mocks.runHermesTask.mock.calls[0]?.[0];
    expect(call.taskId).toBeUndefined();
    expect(call.llm).toEqual({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-test',
      model: 'model-x',
      contextWindow: 128_000,
    });
    expect(call.timeoutMs).toBe(45 * 60_000);
    expect(call.prompt).toContain('### Skill A (skill-a)');
    expect(call.prompt).toContain('Focus on tests.');
    expect(mocks.requestProposals).not.toHaveBeenCalled();
    expect(mocks.taskCreate).toHaveBeenCalledTimes(2);
  });

  it('falls back to the direct LLM request when hermes writes no file', async () => {
    stubHermesPath();
    mocks.runHermesTask.mockResolvedValue(undefined);
    mocks.requestProposals.mockResolvedValue([proposal(1)]);
    await generateProposals('repo-1');

    expect(mocks.requestProposals).toHaveBeenCalled();
    expect(mocks.taskCreate).toHaveBeenCalledTimes(1);
  });

  it('falls back to the direct LLM request when the file is invalid', async () => {
    stubHermesPath();
    hermesWritesFile('the agent wrote prose instead of JSON');
    mocks.requestProposals.mockResolvedValue([proposal(1)]);
    await generateProposals('repo-1');

    expect(mocks.requestProposals).toHaveBeenCalled();
    expect(mocks.taskCreate).toHaveBeenCalledTimes(1);
  });
});

describe('parseProposalsFile', () => {
  it('parses a plain JSON array', () => {
    expect(parseProposalsFile('[{"title":"T","prompt":"P"}]')).toEqual([
      { title: 'T', prompt: 'P' },
    ]);
  });

  it('parses JSON wrapped in markdown fences', () => {
    const raw = '```json\n[{"title":"T","prompt":"P"}]\n```';
    expect(parseProposalsFile(raw)).toEqual([{ title: 'T', prompt: 'P' }]);
  });

  it('parses JSON embedded in surrounding prose', () => {
    const raw = 'Here are the proposals:\n[{"title":"T","prompt":"P"}]\nDone.';
    expect(parseProposalsFile(raw)).toEqual([{ title: 'T', prompt: 'P' }]);
  });

  it('returns null for malformed JSON or schema mismatches', () => {
    expect(parseProposalsFile('not json at all')).toBeNull();
    expect(parseProposalsFile('[{"title":"T"}]')).toBeNull();
    expect(parseProposalsFile('{"title":"T","prompt":"P"}')).toBeNull();
  });
});

describe('buildHermesProposalPrompt', () => {
  it('includes the skills section and owner instructions when provided', () => {
    const prompt = buildHermesProposalPrompt({
      maxProposals: 5,
      skillsSection: '## Active skills\n\n### Skill A (skill-a)\nDo things well',
      systemPromptExtra: 'Focus on tests.',
    });
    expect(prompt).toContain('.lemniscate-proposals.json');
    expect(prompt).toContain('up to 5');
    expect(prompt).toContain('### Skill A (skill-a)');
    expect(prompt).toContain('Focus on tests.');
    expect(prompt).toContain('Do NOT');
  });

  it('omits empty extras', () => {
    const prompt = buildHermesProposalPrompt({
      maxProposals: 5,
      skillsSection: '',
      systemPromptExtra: null,
    });
    expect(prompt).not.toContain('Additional instructions');
    expect(prompt).not.toContain('Active skills');
  });
});
