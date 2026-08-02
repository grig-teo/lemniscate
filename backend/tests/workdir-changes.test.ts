import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locks the meaningful-changes rule: pre-run attachments (.mcp.json,
// AGENTS.md, .agents/skills/) and agent scratch must NOT count as produced
// changes — otherwise a read-only run commits an attachments-only PR and
// the task moves to done with zero implementation.

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  scrub: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/agent-git.js', () => ({ git: mocks.git }));
vi.mock('../src/lib/workdir-scrub.js', () => ({ scrubAgentScratchFiles: mocks.scrub }));

import { hasMeaningfulChanges } from '../src/lib/workdir-changes.js';

type GitCall = string[];

// Mock git per subcommand: [0]=args. Returns a fn suitable for mockImplementation.
function gitAnswers(answers: { status: string; remote?: string; ahead?: string }) {
  return (args: GitCall) => {
    if (args[0] === 'status') return Promise.resolve(answers.status);
    if (args[0] === 'remote') return Promise.resolve(answers.remote ?? 'origin\n');
    if (args[0] === 'rev-list') return Promise.resolve(answers.ahead ?? '0\n');
    return Promise.resolve('');
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scrub.mockResolvedValue(undefined);
});

describe('hasMeaningfulChanges', () => {
  it('returns false when only pre-run attachments are dirty', async () => {
    mocks.git.mockImplementation(gitAnswers({
      status: '?? .mcp.json\n?? AGENTS.md\n?? .agents/skills/deploy/SKILL.md\n',
    }));

    expect(await hasMeaningfulChanges('/wd')).toBe(false);
    expect(mocks.scrub).toHaveBeenCalledWith('/wd');
  });

  it('returns true when a real source file changed', async () => {
    mocks.git.mockResolvedValue(' M src/app.ts\n?? .mcp.json\n');

    expect(await hasMeaningfulChanges('/wd')).toBe(true);
  });

  it('returns true for a new real file even alongside attachments', async () => {
    mocks.git.mockResolvedValue('?? src/feature/new.ts\n?? .agents/skills/x/SKILL.md\n');

    expect(await hasMeaningfulChanges('/wd')).toBe(true);
  });

  it('returns false on a clean workdir with no local commits', async () => {
    mocks.git.mockImplementation(gitAnswers({ status: '', ahead: '0\n' }));

    expect(await hasMeaningfulChanges('/wd')).toBe(false);
  });

  it('returns true on a CLEAN workdir when the agent committed its changes', async () => {
    // The lemcore prompt encourages committing per step; such a run has no
    // dirty paths but real work on the branch (prod false-failure class).
    mocks.git.mockImplementation(gitAnswers({ status: '', ahead: '3\n' }));

    expect(await hasMeaningfulChanges('/wd')).toBe(true);
  });

  it('skips the local-commit check when the workdir has no remotes', async () => {
    mocks.git.mockImplementation(gitAnswers({ status: '', remote: '' }));

    expect(await hasMeaningfulChanges('/wd')).toBe(false);
  });

  it('handles renamed and quoted porcelain paths', async () => {
    mocks.git.mockResolvedValue('R  "old name.ts" -> "new name.ts"\n');

    expect(await hasMeaningfulChanges('/wd')).toBe(true);
  });
});
