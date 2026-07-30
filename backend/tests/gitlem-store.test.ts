import { describe, expect, it } from 'vitest';
import {
  addBranch,
  emptyGitlemDoc,
  openPullRequest,
  parseGitlemDoc,
  readFile,
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

describe('openPullRequest', () => {
  it('assigns sequential numbers and stores the PR as open', () => {
    const doc = emptyGitlemDoc();
    const first = openPullRequest(doc, { title: 'a', body: '', head: 'dev', base: 'main' });
    const second = openPullRequest(doc, { title: 'b', body: '', head: 'dev2', base: 'main' });
    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    expect(doc.prs.every((pr) => pr.state === 'open')).toBe(true);
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
});
