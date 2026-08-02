import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the prompt handed to runLemcoreLoop so we can assert AGENTS.md
// content made it into the lemcore system prompt (the gap: the internal
// executor loaded AGENTS.md via buildRepoContext, lemcore did not).
const capturedPrompt = vi.fn();

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    task: { update: vi.fn(), findUnique: vi.fn() },
    skill: { findMany: vi.fn(), findUnique: vi.fn() },
    mcpServer: { findMany: vi.fn() },
  },
}));

vi.mock('../src/lib/agent-git.js', () => ({
  logEvent: vi.fn(async () => {}),
  hasDirtyWorkdir: vi.fn(async () => false),
}));

vi.mock('../src/lib/workdir-changes.js', () => ({
  hasMeaningfulChanges: vi.fn(async () => false),
}));

vi.mock('../src/lib/task-skills.js', () => ({
  loadTaskSkills: vi.fn(async () => []),
  loadAgentsMdTemplate: vi.fn(async () => null),
}));

vi.mock('../src/lib/lemcore/loop.js', () => ({
  runLemcoreLoop: vi.fn(async (opts: { prompt: string }) => {
    capturedPrompt(opts.prompt);
    return 'done';
  }),
  loadTranscript: vi.fn(() => null),
  scrubLegacyInCloneTranscript: vi.fn(),
}));

import { runLemcoreTask } from '../src/lib/lemcore/run.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'lemcore-agents-md-'));
  capturedPrompt.mockClear();
});

afterEach(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(workdir, { recursive: true, force: true }));
  vi.clearAllMocks();
});

function makeRt() {
  return { cfg: { systemPromptExtra: '', contextWindow: 32_000 } } as unknown as import('../src/lib/agent-runtime.js').LlmRuntime;
}

function makeTask() {
  return {
    id: 't1',
    title: 'edit a file',
    prompt: 'change something',
    repository: { agentsMdSkillId: null, defaultBranch: 'main', connection: {}, fullName: 'o/r' },
  } as unknown as import('../src/lib/agent-runtime.js').TaskWithRepo;
}

describe('lemcore loads AGENTS.md into the prompt', () => {
  it('includes the repo root AGENTS.md content in the prompt', async () => {
    const agentsMd = '# Project rules\n\n- Never exceed 200 lines per file.\n- Use guard clauses.';
    await writeFile(path.join(workdir, 'AGENTS.md'), agentsMd);

    await runLemcoreTask({
      taskId: 't1',
      task: makeTask(),
      workdir,
      rt: makeRt(),
      secrets: [],
      resume: false,
    });

    expect(capturedPrompt).toHaveBeenCalledTimes(1);
    const prompt = capturedPrompt.mock.calls[0]![0] as string;
    expect(prompt).toContain('Project rules');
    expect(prompt).toContain('Never exceed 200 lines per file');
  });

  it('still runs when there is no AGENTS.md', async () => {
    await runLemcoreTask({
      taskId: 't2',
      task: makeTask(),
      workdir,
      rt: makeRt(),
      secrets: [],
      resume: false,
    });

    expect(capturedPrompt).toHaveBeenCalledTimes(1);
  });

  it('includes the AGENTS.md template skill when no root file exists', async () => {
    const { loadAgentsMdTemplate } = await import('../src/lib/task-skills.js');
    vi.mocked(loadAgentsMdTemplate).mockResolvedValueOnce(
      '# Template rules\n\n- Write tests first (TDD).',
    );

    await runLemcoreTask({
      taskId: 't3',
      task: makeTask(),
      workdir,
      rt: makeRt(),
      secrets: [],
      resume: false,
    });

    const prompt = capturedPrompt.mock.calls[0]![0] as string;
    expect(prompt).toContain('Template rules');
    expect(prompt).toContain('Write tests first');
  });

  it('root AGENTS.md wins over the template', async () => {
    const { loadAgentsMdTemplate } = await import('../src/lib/task-skills.js');
    vi.mocked(loadAgentsMdTemplate).mockResolvedValueOnce('# Template rules\n\n- TDD.');
    await writeFile(path.join(workdir, 'AGENTS.md'), '# Root rules\n\n- 200 line max.');

    await runLemcoreTask({
      taskId: 't4',
      task: makeTask(),
      workdir,
      rt: makeRt(),
      secrets: [],
      resume: false,
    });

    const prompt = capturedPrompt.mock.calls[0]![0] as string;
    expect(prompt).toContain('Root rules');
    expect(prompt).not.toContain('Template rules');
  });
});
