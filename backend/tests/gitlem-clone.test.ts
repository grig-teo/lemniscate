import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Locking test for the clone materialization: a gitlem document (branches +
// files) becomes a real git repository that `git clone` can check out —
// this is what makes the advertised clone URL actually clonable.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  repoFindUnique: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    gitlemUser: { findUnique: mocks.userFindUnique },
    gitlemRepository: { findUnique: mocks.repoFindUnique },
  },
}));

import { materializeGitlemRepo, resetGitlemCloneCache } from '../src/lib/gitlem-clone.js';

const DOC = JSON.stringify({
  branches: [
    { name: 'main', files: [{ path: 'README.md', content: '# demo\n' }] },
    { name: 'dev', files: [{ path: 'src/app.ts', content: 'export {};\n' }] },
  ],
  prs: [],
  ciRuns: [],
  nextPrNumber: 1,
  nextRunId: 1,
});

function mockRepo(doc: string = DOC) {
  mocks.userFindUnique.mockResolvedValue({ id: 'gu-1', username: 'alice' });
  mocks.repoFindUnique.mockResolvedValue({ id: 'r-1', doc, defaultBranch: 'main' });
}

describe('materializeGitlemRepo', () => {
  let cloneTarget: string | null = null;

  afterEach(async () => {
    resetGitlemCloneCache();
    if (cloneTarget) await rm(cloneTarget, { recursive: true, force: true });
    cloneTarget = null;
  });

  it('returns null for unknown repos and users', async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    expect(await materializeGitlemRepo('ghost', 'demo')).toBeNull();
    mocks.userFindUnique.mockResolvedValue({ id: 'gu-1', username: 'alice' });
    mocks.repoFindUnique.mockResolvedValue(null);
    expect(await materializeGitlemRepo('alice', 'demo')).toBeNull();
  });

  it('materializes the doc into a clonable git repo with all branches', async () => {
    mockRepo();
    const gitDir = await materializeGitlemRepo('alice', 'demo');
    expect(gitDir).not.toBeNull();

    cloneTarget = await mkdtemp(join(tmpdir(), 'gitlem-checkout-'));
    execFileSync('git', ['clone', '--quiet', gitDir!, join(cloneTarget, 'demo')]);
    const readme = execFileSync('git', ['-C', join(cloneTarget, 'demo'), 'show', 'HEAD:README.md'])
      .toString();
    expect(readme).toBe('# demo\n');
    const branches = execFileSync('git', ['-C', join(cloneTarget, 'demo'), 'branch', '-r'])
      .toString();
    expect(branches).toContain('origin/main');
    expect(branches).toContain('origin/dev');
  });

  it('materializes an empty repo (cloneable, no commits)', async () => {
    mockRepo(JSON.stringify({ branches: [], prs: [], ciRuns: [], nextPrNumber: 1, nextRunId: 1 }));
    const gitDir = await materializeGitlemRepo('alice', 'demo');
    cloneTarget = await mkdtemp(join(tmpdir(), 'gitlem-checkout-'));
    execFileSync('git', ['clone', '--quiet', gitDir!, join(cloneTarget, 'demo')]);
  });
});
