import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// End-to-end push → doc ingest: a real `git push` against a gitlem bare repo
// writes objects + refs; ingestPushedRefs reads those refs back out and writes
// them into the repo's JSON doc. This is what makes the agent's `git push`
// survive (the doc is the durable source of truth, the bare repo is a cache).
// Only the prisma doc write is mocked — everything else is real git.

const mocks = vi.hoisted(() => ({
  doc: { current: { branches: [], prs: [], ciRuns: [], nextPrNumber: 1, nextRunId: 1 } },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        gitlemRepository: {
          findUniqueOrThrow: async () => ({ id: 'repo-1', doc: JSON.stringify(mocks.doc.current) }),
          update: async ({ data }: { data: { doc: string } }) => {
            mocks.doc.current = JSON.parse(data.doc);
            return {};
          },
        },
      }),
  },
}));

import { ingestPushedRefs } from '../src/lib/gitlem-ingest.js';
import { parseGitlemDoc } from '../src/lib/gitlem-store.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
};

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'ignore', 'pipe'] });
}

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'gitlem-push-'));
  mocks.doc.current = { branches: [], prs: [], ciRuns: [], nextPrNumber: 1, nextRunId: 1 };
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe('ingestPushedRefs', () => {
  it('reads pushed files into the doc and replaces the branch tree', async () => {
    // A bare "gitlem" repo with an initial main branch.
    const bareDir = join(workRoot, 'repo.git');
    git(['init', '--bare', '-b', 'main', bareDir], workRoot);
    // A working clone the agent would push from.
    const cloneDir = join(workRoot, 'work');
    git(['clone', bareDir, cloneDir], workRoot);
    execFileSync('node', ['-e', `
      require('fs').writeFileSync('${cloneDir}/README.md', '# hi\\n');
      require('fs').mkdirSync('${cloneDir}/src');
      require('fs').writeFileSync('${cloneDir}/src/app.ts', 'export const x = 1;\\n');
    `]);
    git(['add', '-A'], cloneDir);
    git(['commit', '-m', 'init'], cloneDir);
    git(['push', '-q', 'origin', 'main'], cloneDir);

    const result = await ingestPushedRefs('repo-1', bareDir);

    expect(result.branches).toBe(1);
    const doc = parseGitlemDoc(JSON.stringify(mocks.doc.current));
    const main = doc.branches.find((b) => b.name === 'main');
    expect(main?.files.map((f) => f.path).sort()).toEqual(['README.md', 'src/app.ts']);
    const readme = main?.files.find((f) => f.path === 'README.md');
    expect(readme?.content).toBe('# hi\n');
  });

  it('reflects an updated push: removed files disappear from the doc', async () => {
    const bareDir = join(workRoot, 'repo.git');
    git(['init', '--bare', '-b', 'main', bareDir], workRoot);
    const cloneDir = join(workRoot, 'work');
    git(['clone', bareDir, cloneDir], workRoot);
    execFileSync('node', ['-e', `
      require('fs').writeFileSync('${cloneDir}/keep.txt', 'keep\\n');
      require('fs').writeFileSync('${cloneDir}/drop.txt', 'drop\\n');
    `]);
    git(['add', '-A'], cloneDir);
    git(['commit', '-m', 'two'], cloneDir);
    git(['push', '-q', 'origin', 'main'], cloneDir);
    await ingestPushedRefs('repo-1', bareDir);

    // Second push removes drop.txt.
    execFileSync('node', ['-e', `require('fs').rmSync('${cloneDir}/drop.txt')`]);
    git(['add', '-A'], cloneDir);
    git(['commit', '-m', 'drop'], cloneDir);
    git(['push', '-q', 'origin', 'main'], cloneDir);
    // Reset the mock doc so the replace (not merge) is visible.
    mocks.doc.current = { branches: [], prs: [], ciRuns: [], nextPrNumber: 1, nextRunId: 1 };
    const result = await ingestPushedRefs('repo-1', bareDir);

    expect(result.branches).toBe(1);
    const doc = parseGitlemDoc(JSON.stringify(mocks.doc.current));
    const paths = doc.branches.find((b) => b.name === 'main')?.files.map((f) => f.path);
    expect(paths).toEqual(['keep.txt']);
  });

  it('skips binary files', async () => {
    const bareDir = join(workRoot, 'repo.git');
    git(['init', '--bare', '-b', 'main', bareDir], workRoot);
    const cloneDir = join(workRoot, 'work');
    git(['clone', bareDir, cloneDir], workRoot);
    // A file with a NUL byte in the first 8KB → binary → skipped.
    execFileSync('node', ['-e', `
      require('fs').writeFileSync('${cloneDir}/blob.bin', Buffer.from([0x00, 0x01, 0x02, 0x00]));
      require('fs').writeFileSync('${cloneDir}/text.txt', 'plain text\\n');
    `]);
    git(['add', '-A'], cloneDir);
    git(['commit', '-m', 'mixed'], cloneDir);
    git(['push', '-q', 'origin', 'main'], cloneDir);

    const result = await ingestPushedRefs('repo-1', bareDir);

    const doc = parseGitlemDoc(JSON.stringify(mocks.doc.current));
    const paths = doc.branches.find((b) => b.name === 'main')?.files.map((f) => f.path);
    expect(paths).toEqual(['text.txt']);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it('preserves PRs and counters across an ingest', async () => {
    const bareDir = join(workRoot, 'repo.git');
    git(['init', '--bare', '-b', 'main', bareDir], workRoot);
    const cloneDir = join(workRoot, 'work');
    git(['clone', bareDir, cloneDir], workRoot);
    execFileSync('node', ['-e', `require('fs').writeFileSync('${cloneDir}/a.txt', 'a\\n')`]);
    git(['add', '-A'], cloneDir);
    git(['commit', '-m', 'a'], cloneDir);
    git(['push', '-q', 'origin', 'main'], cloneDir);

    // Seed the doc with a PR + bumped counters the ingest must NOT clobber.
    mocks.doc.current = {
      branches: [],
      prs: [{ number: 7, title: 'p', body: '', head: 'dev', base: 'main', state: 'open', createdAt: 'x' }],
      ciRuns: [],
      nextPrNumber: 8,
      nextRunId: 3,
    };
    await ingestPushedRefs('repo-1', bareDir);

    const doc = parseGitlemDoc(JSON.stringify(mocks.doc.current));
    expect(doc.prs).toHaveLength(1);
    expect(doc.prs[0]?.number).toBe(7);
    expect(doc.nextPrNumber).toBe(8);
    expect(doc.nextRunId).toBe(3);
  });
});
