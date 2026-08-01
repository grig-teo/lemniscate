import { describe, expect, it } from 'vitest';
import {
  GITLEM_MAX_HISTORY,
  addBranch,
  closePullRequest,
  emptyGitlemDoc,
  findPullRequest,
  isValidGitlemBranchName,
  mergePullRequest,
  openPullRequest,
  parseGitlemDoc,
  readFile,
  replaceBranchTree,
  startCiRun,
  upsertFile,
} from '../src/lib/gitlem-store.js';

// Locking tests for the gitlem repository document model: branch file
// trees, PR numbering, and the deterministic pseudo CI/CD run.

describe('parseGitlemDoc', () => {
  it('parses a stored doc and fills defaults for missing counters', () => {
    const doc = parseGitlemDoc(JSON.stringify({ branches: [], prs: [] }));
    expect(doc.ciRuns).toEqual([]);
    expect(doc.nextPrNumber).toBe(1);
    expect(doc.nextRunId).toBe(1);
  });

  it('returns an empty doc for invalid JSON', () => {
    expect(parseGitlemDoc('{nope')).toEqual(emptyGitlemDoc());
  });
});

describe('branch + file operations', () => {
  it('addBranch copies the source tree and rejects duplicates', () => {
    const doc = emptyGitlemDoc();
    upsertFile(doc, 'main', 'README.md', '# hi');
    expect(addBranch(doc, 'dev', 'main')).toBe(true);
    expect(readFile(doc, 'dev', 'README.md')?.content).toBe('# hi');
    expect(addBranch(doc, 'dev', 'main')).toBe(false);
  });

  it('branch copies are independent of the source tree', () => {
    const doc = emptyGitlemDoc();
    upsertFile(doc, 'main', 'a.txt', 'one');
    addBranch(doc, 'dev', 'main');
    upsertFile(doc, 'dev', 'a.txt', 'two');
    expect(readFile(doc, 'main', 'a.txt')?.content).toBe('one');
  });

  it('upsertFile updates existing files and creates missing branches', () => {
    const doc = emptyGitlemDoc();
    upsertFile(doc, 'feature', 'x.ts', 'v1');
    upsertFile(doc, 'feature', 'x.ts', 'v2');
    expect(readFile(doc, 'feature', 'x.ts')?.content).toBe('v2');
    expect(doc.branches).toHaveLength(1);
  });
});

// A git push defines the full authoritative state of the pushed branch, so the
// ingest path replaces (not merges) that branch's file tree. PRs/CI/nextPrNumber
// survive — a push must not clobber the repo's history metadata.
describe('replaceBranchTree', () => {
  it('replaces an existing branch tree, removing files no longer present', () => {
    const doc = emptyGitlemDoc();
    upsertFile(doc, 'main', 'README.md', '# hi');
    upsertFile(doc, 'main', 'old.txt', 'gone');
    openPullRequest(doc, { title: 'pr', body: '', head: 'dev', base: 'main' });

    replaceBranchTree(doc, 'main', [{ path: 'README.md', content: '# hi v2' }, { path: 'new.txt', content: 'fresh' }]);

    expect(readFile(doc, 'main', 'README.md')?.content).toBe('# hi v2');
    expect(readFile(doc, 'main', 'new.txt')?.content).toBe('fresh');
    expect(readFile(doc, 'main', 'old.txt')).toBeUndefined();
    // PRs and counters are untouched.
    expect(doc.prs).toHaveLength(1);
  });

  it('creates the branch when it does not exist yet', () => {
    const doc = emptyGitlemDoc();
    replaceBranchTree(doc, 'feature', [{ path: 'a.txt', content: 'a' }]);
    expect(readFile(doc, 'feature', 'a.txt')?.content).toBe('a');
    expect(doc.branches.map((b) => b.name)).toContain('feature');
  });

  it('does not affect other branches', () => {
    const doc = emptyGitlemDoc();
    upsertFile(doc, 'main', 'keep.txt', 'main');
    replaceBranchTree(doc, 'other', [{ path: 'o.txt', content: 'o' }]);
    expect(readFile(doc, 'main', 'keep.txt')?.content).toBe('main');
  });
});

describe('openPullRequest', () => {
  it('assigns sequential numbers and stores the PR as open', () => {
    const doc = emptyGitlemDoc();
    const first = openPullRequest(doc, { title: 'a', body: '', head: 'dev', base: 'main' });
    const second = openPullRequest(doc, { title: 'b', body: '', head: 'dev2', base: 'main' });
    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    expect(doc.prs.every((pr) => pr.state === 'open')).toBe(true);
  });

  it('caps stored PRs at the latest GITLEM_MAX_HISTORY entries', () => {
    const doc = emptyGitlemDoc();
    for (let i = 0; i < GITLEM_MAX_HISTORY + 10; i += 1) {
      openPullRequest(doc, { title: `pr ${i}`, body: '', head: `h${i}`, base: 'main' });
    }
    expect(doc.prs).toHaveLength(GITLEM_MAX_HISTORY);
    expect(doc.prs.at(-1)?.number).toBe(GITLEM_MAX_HISTORY + 10);
  });
});

describe('mergePullRequest', () => {
  it('applies the head tree onto the base branch, head wins per path', () => {
    const doc = emptyGitlemDoc();
    upsertFile(doc, 'main', 'README.md', '# base');
    upsertFile(doc, 'main', 'keep.txt', 'base only');
    upsertFile(doc, 'dev', 'README.md', '# head');
    upsertFile(doc, 'dev', 'feature.ts', 'new');
    const pr = openPullRequest(doc, { title: 't', body: '', head: 'dev', base: 'main' });
    expect(mergePullRequest(doc, pr.number)).toBe(true);
    expect(pr.state).toBe('merged');
    expect(readFile(doc, 'main', 'README.md')?.content).toBe('# head');
    expect(readFile(doc, 'main', 'feature.ts')?.content).toBe('new');
    expect(readFile(doc, 'main', 'keep.txt')?.content).toBe('base only');
  });

  it('returns false for an unknown PR number', () => {
    expect(mergePullRequest(emptyGitlemDoc(), 42)).toBe(false);
  });
});

describe('findPullRequest', () => {
  it('prefers the open PR over an older closed one for the same pair', () => {
    const doc = emptyGitlemDoc();
    const first = openPullRequest(doc, { title: 'a', body: '', head: 'dev', base: 'main' });
    closePullRequest(doc, first.number, 'closed');
    openPullRequest(doc, { title: 'b', body: '', head: 'dev', base: 'main' });
    expect(findPullRequest(doc, 'dev', 'main')?.state).toBe('open');
  });

  it('falls back to the latest PR by number when none is open', () => {
    const doc = emptyGitlemDoc();
    const first = openPullRequest(doc, { title: 'a', body: '', head: 'dev', base: 'main' });
    closePullRequest(doc, first.number, 'closed');
    const second = openPullRequest(doc, { title: 'b', body: '', head: 'dev', base: 'main' });
    closePullRequest(doc, second.number, 'merged');
    expect(findPullRequest(doc, 'dev', 'main')?.number).toBe(second.number);
  });

  it('returns undefined when no PR matches the branch pair', () => {
    expect(findPullRequest(emptyGitlemDoc(), 'dev', 'main')).toBeUndefined();
  });
});

describe('isValidGitlemBranchName', () => {
  it('accepts ordinary branch names', () => {
    for (const name of ['main', 'feature/foo', 'fix-123', 'release.v2', 'dev']) {
      expect(isValidGitlemBranchName(name)).toBe(true);
    }
  });

  it('rejects names that are unsafe as git refnames or argv', () => {
    const bad = ['-m', '--upload-pack=x', 'a..b', 'a~b', 'has space', 'ctrl\tchar', '', '.hidden', 'a.lock', 'a^b', 'a:b', 'a b'];
    for (const name of bad) {
      expect(isValidGitlemBranchName(name)).toBe(false);
    }
  });
});

describe('addBranch validation', () => {
  it('rejects git-refname-unsafe names instead of storing them', () => {
    const doc = emptyGitlemDoc();
    expect(addBranch(doc, '-m injected', 'main')).toBe(false);
    expect(doc.branches).toHaveLength(0);
  });
});

describe('startCiRun', () => {
  it('succeeds when the branch has files, fails on an empty tree', () => {
    const doc = emptyGitlemDoc();
    upsertFile(doc, 'main', 'README.md', '# hi');
    const ok = startCiRun(doc, 'main');
    const empty = startCiRun(doc, 'missing');
    expect(ok.status).toBe('success');
    expect(ok.log).toContain('result: success');
    expect(empty.status).toBe('failed');
    expect(doc.ciRuns.map((run) => run.id)).toEqual(['run-2', 'run-1']);
  });

  it('caps stored CI runs at the latest GITLEM_MAX_HISTORY entries', () => {
    const doc = emptyGitlemDoc();
    upsertFile(doc, 'main', 'README.md', '# hi');
    for (let i = 0; i < GITLEM_MAX_HISTORY + 5; i += 1) {
      startCiRun(doc, 'main');
    }
    expect(doc.ciRuns).toHaveLength(GITLEM_MAX_HISTORY);
    expect(doc.ciRuns[0]?.id).toBe(`run-${GITLEM_MAX_HISTORY + 5}`);
  });
});
