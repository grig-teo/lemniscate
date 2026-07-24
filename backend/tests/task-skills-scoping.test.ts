import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for per-user library scoping in lib/task-skills.ts:
// queries with a userId see global rows (userId NULL) plus their own;
// without a userId (worker paths) the legacy unscoped behavior is kept.

const mocks = vi.hoisted(() => ({
  skillFindMany: vi.fn(),
  skillFindUnique: vi.fn(),
  mcpFindMany: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    skill: { findMany: mocks.skillFindMany, findUnique: mocks.skillFindUnique },
    mcpServer: { findMany: mocks.mcpFindMany },
  },
}));
vi.mock('../src/lib/agent-git.js', () => ({ logEvent: mocks.logEvent }));

import {
  findUnknownMcpServerSlugs,
  findUnknownSkillSlugs,
  isAgentsMdSkill,
  libraryMutationBlocker,
  libraryScopeWhere,
  loadAgentsMdTemplate,
  resolveMcpServerConfigs,
} from '../src/lib/task-skills.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('libraryScopeWhere', () => {
  it('scopes to global + owner rows when a userId is given', () => {
    expect(libraryScopeWhere('user-1')).toEqual({
      OR: [{ userId: null }, { userId: 'user-1' }],
    });
  });

  it('is empty without a userId (legacy unscoped view)', () => {
    expect(libraryScopeWhere(undefined)).toEqual({});
  });
});

describe('libraryMutationBlocker', () => {
  it('allows the owner', () => {
    expect(libraryMutationBlocker('user-1', 'user-1')).toBeNull();
  });

  it('forbids global (seeded) entries', () => {
    expect(libraryMutationBlocker(null, 'user-1')).toMatch(/[Gg]lobal/);
  });

  it("forbids other users' entries", () => {
    expect(libraryMutationBlocker('user-2', 'user-1')).toMatch(/another user/);
  });
});

describe('slug lookups', () => {
  it('scopes findUnknownSkillSlugs to global + owner rows', async () => {
    mocks.skillFindMany.mockResolvedValue([{ slug: 'known' }]);
    const unknown = await findUnknownSkillSlugs(['known', 'other'], 'user-1');
    expect(mocks.skillFindMany).toHaveBeenCalledWith({
      where: { slug: { in: ['known', 'other'] }, OR: [{ userId: null }, { userId: 'user-1' }] },
      select: { slug: true },
    });
    expect(unknown).toEqual(['other']);
  });

  it('keeps findUnknownSkillSlugs unscoped without a userId', async () => {
    mocks.skillFindMany.mockResolvedValue([{ slug: 'known' }]);
    await findUnknownSkillSlugs(['known']);
    expect(mocks.skillFindMany).toHaveBeenCalledWith({
      where: { slug: { in: ['known'] } },
      select: { slug: true },
    });
  });

  it('scopes findUnknownMcpServerSlugs to global + owner rows', async () => {
    mocks.mcpFindMany.mockResolvedValue([]);
    await findUnknownMcpServerSlugs(['x'], 'user-1');
    expect(mocks.mcpFindMany).toHaveBeenCalledWith({
      where: { slug: { in: ['x'] }, OR: [{ userId: null }, { userId: 'user-1' }] },
      select: { slug: true },
    });
  });

  it('scopes resolveMcpServerConfigs to global + owner rows', async () => {
    mocks.mcpFindMany.mockResolvedValue([{ slug: 'x', config: { command: 'npx' } }]);
    const configs = await resolveMcpServerConfigs(['x'], 'user-1');
    expect(mocks.mcpFindMany).toHaveBeenCalledWith({
      where: { slug: { in: ['x'] }, OR: [{ userId: null }, { userId: 'user-1' }] },
      select: { slug: true, config: true },
    });
    expect(configs).toEqual({ x: { command: 'npx' } });
  });
});

describe('agents_md template access', () => {
  it('rejects another user’s agents_md skill for isAgentsMdSkill', async () => {
    mocks.skillFindUnique.mockResolvedValue({ kind: 'agents_md', userId: 'user-2' });
    expect(await isAgentsMdSkill('s1', 'user-1')).toBe(false);
  });

  it('accepts global and own agents_md skills', async () => {
    mocks.skillFindUnique.mockResolvedValue({ kind: 'agents_md', userId: null });
    expect(await isAgentsMdSkill('s1', 'user-1')).toBe(true);
    mocks.skillFindUnique.mockResolvedValue({ kind: 'agents_md', userId: 'user-1' });
    expect(await isAgentsMdSkill('s1', 'user-1')).toBe(true);
  });

  it('keeps isAgentsMdSkill kind-only without a userId', async () => {
    mocks.skillFindUnique.mockResolvedValue({ kind: 'agents_md', userId: 'user-2' });
    expect(await isAgentsMdSkill('s1')).toBe(true);
  });

  it('returns null from loadAgentsMdTemplate for another user’s template', async () => {
    mocks.skillFindUnique.mockResolvedValue({
      kind: 'agents_md',
      userId: 'user-2',
      content: 'secret',
    });
    expect(await loadAgentsMdTemplate({ agentsMdSkillId: 's1' }, 'user-1')).toBeNull();
  });

  it('loads a global template for any user', async () => {
    mocks.skillFindUnique.mockResolvedValue({
      kind: 'agents_md',
      userId: null,
      content: 'global rules',
    });
    expect(await loadAgentsMdTemplate({ agentsMdSkillId: 's1' }, 'user-1')).toBe('global rules');
  });
});
