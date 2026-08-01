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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scrub.mockResolvedValue(undefined);
});

describe('hasMeaningfulChanges', () => {
  it('returns false when only pre-run attachments are dirty', async () => {
    mocks.git.mockResolvedValue('?? .mcp.json\n?? AGENTS.md\n?? .agents/skills/deploy/SKILL.md\n');

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

  it('returns false on a clean workdir', async () => {
    mocks.git.mockResolvedValue('');

    expect(await hasMeaningfulChanges('/wd')).toBe(false);
  });

  it('handles renamed and quoted porcelain paths', async () => {
    mocks.git.mockResolvedValue('R  "old name.ts" -> "new name.ts"\n');

    expect(await hasMeaningfulChanges('/wd')).toBe(true);
  });
});
