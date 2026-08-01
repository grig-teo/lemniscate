import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/lib/crypto.js';
import {
  emptyGitlemDoc,
  openPullRequest,
  readFile,
  startCiRun,
  upsertFile,
  type GitlemRepoDoc,
} from '../src/lib/gitlem-store.js';
import { ProviderError } from '../src/lib/git-providers.js';
import { gitlemPrApi } from '../src/lib/pr-gitlem.js';

// Locking tests for the gitlem PR provider (lib/pr-gitlem.ts): the
// document-store-backed open/merge/state/list/checks path. prisma is mocked
// with an in-memory document so no database is needed.

const mocks = vi.hoisted(() => ({
  doc: { current: null as GitlemRepoDoc | null },
  userFindUnique: vi.fn(),
  repoFindUnique: vi.fn(),
}));

// Reads always reflect the current in-memory doc; writes inside the
// transaction replace it (mirrors the real read-modify-write row update).
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    gitlemUser: { findUnique: mocks.userFindUnique },
    gitlemRepository: {
      findUnique: mocks.repoFindUnique,
      update: async ({ data }: { data: { doc: string } }) => {
        mocks.doc.current = JSON.parse(data.doc) as GitlemRepoDoc;
        return {};
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        gitlemRepository: {
          findUniqueOrThrow: async () => ({ id: 'repo-1', doc: JSON.stringify(mocks.doc.current) }),
          update: async ({ data }: { data: { doc: string } }) => {
            mocks.doc.current = JSON.parse(data.doc) as GitlemRepoDoc;
            return {};
          },
        },
      }),
  },
}));

// The connection's decrypted token is the account's gitlem PAT; 'alice' owns
// the mocked repo (repo-1), so 'alice/<name>' resolves and anything else
// must fail closed.
const api = gitlemPrApi({ provider: 'gitlem', baseUrl: null, accessTokenEnc: encrypt('pat-alice') });
const REF = { repoFullName: 'alice/demo', headBranch: 'dev', baseBranch: 'main' };

function seedDoc(): GitlemRepoDoc {
  const doc = emptyGitlemDoc();
  upsertFile(doc, 'main', 'README.md', '# demo');
  upsertFile(doc, 'dev', 'feature.ts', 'export const x = 1;');
  mocks.doc.current = doc;
  return doc;
}

beforeEach(() => {
  vi.clearAllMocks();
  seedDoc();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', username: 'alice' });
  mocks.repoFindUnique.mockImplementation(async () => ({
    id: 'repo-1',
    doc: JSON.stringify(mocks.doc.current),
  }));
});

describe('gitlemPrApi.open', () => {
  it('opens a PR with the head/base branches and returns its URL', async () => {
    const result = await api.open({ ...REF, title: 'Add feature', body: 'details' });
    expect(result.prUrl).toBe('/gitlem/repos/alice/demo/pulls/1');
    expect(mocks.doc.current?.prs).toHaveLength(1);
    expect(mocks.doc.current?.prs[0]).toMatchObject({ head: 'dev', base: 'main', state: 'open' });
  });

  it('returns the existing open PR instead of creating a duplicate', async () => {
    openPullRequest(mocks.doc.current!, { title: 't', body: '', head: 'dev', base: 'main' });
    const result = await api.open({ ...REF, title: 'Other', body: '' });
    expect(result.prUrl).toBe('/gitlem/repos/alice/demo/pulls/1');
    expect(mocks.doc.current?.prs).toHaveLength(1);
  });

  it('throws a ProviderError when the repository does not exist', async () => {
    mocks.repoFindUnique.mockResolvedValue(null);
    await expect(api.open({ ...REF, title: 't', body: '' })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('gitlemPrApi ownership (token-scoped)', () => {
  it('rejects when the token does not own the repo namespace', async () => {
    const bobRef = { ...REF, repoFullName: 'bob/demo' };
    await expect(api.diff(bobRef)).rejects.toThrow(/not found/);
    await expect(api.merge(bobRef)).rejects.toThrow(/not found/);
    await expect(api.list('bob/demo')).rejects.toThrow(/not found/);
    expect(mocks.doc.current?.prs).toHaveLength(0);
  });

  it('fails closed on an invalid token', async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    await expect(api.diff(REF)).rejects.toMatchObject({ status: 401 });
  });

  it('fails closed when the connection has no token at all', async () => {
    const noToken = gitlemPrApi({ provider: 'gitlem', baseUrl: null, accessTokenEnc: null });
    await expect(noToken.list('alice/demo')).rejects.toMatchObject({ status: 401 });
  });
});

describe('gitlemPrApi.merge / state / list', () => {
  it('merges the open PR for the head branch and reports the state', async () => {
    await api.open({ ...REF, title: 'Add feature', body: '' });
    const merged = await api.merge(REF);
    expect(merged).toEqual({ merged: true, prUrl: '/gitlem/repos/alice/demo/pulls/1' });
    await expect(api.state(REF)).resolves.toBe('merged');
  });

  it('merge applies the head branch files onto the base branch', async () => {
    upsertFile(mocks.doc.current!, 'dev', 'README.md', '# from dev');
    await api.open({ ...REF, title: 'Add feature', body: '' });
    await api.merge(REF);
    const base = mocks.doc.current!;
    expect(readFile(base, 'main', 'feature.ts')?.content).toBe('export const x = 1;');
    expect(readFile(base, 'main', 'README.md')?.content).toBe('# from dev');
  });

  it('close marks the PR closed without touching the base branch', async () => {
    await api.open({ ...REF, title: 'Add feature', body: '' });
    await api.close(REF);
    await expect(api.state(REF)).resolves.toBe('closed');
    expect(readFile(mocks.doc.current!, 'main', 'feature.ts')).toBeUndefined();
  });

  it('state prefers the reopened open PR over the older closed one', async () => {
    await api.open({ ...REF, title: 'first', body: '' });
    await api.close(REF);
    await api.open({ ...REF, title: 'second', body: '' });
    await expect(api.state(REF)).resolves.toBe('open');
  });

  it('merge rejects when there is no open PR for the branch pair', async () => {
    await expect(api.merge(REF)).rejects.toThrow(/no open pull request/);
  });

  it('lists PRs in the shared ListedPullRequest shape', async () => {
    await api.open({ ...REF, title: 'Add feature', body: '' });
    const listed = await api.list('alice/demo');
    expect(listed).toEqual([{ headBranch: 'dev', baseBranch: 'main', state: 'open' }]);
  });
});

describe('gitlemPrApi.diff / checks', () => {
  it('renders one diff header per file on the head branch', async () => {
    const diff = await api.diff(REF);
    expect(diff).toContain('diff --git a/feature.ts b/feature.ts');
    expect(diff).toContain('export const x = 1;');
  });

  it('diff rejects for an unknown head branch', async () => {
    await expect(api.diff({ ...REF, headBranch: 'nope' })).rejects.toThrow(/branch nope not found/);
  });

  it('checks: no CI run is green, a failed run is failing', async () => {
    await expect(api.checks!(REF)).resolves.toEqual({ supported: true, green: true, state: 'green' });
    startCiRun(mocks.doc.current!, 'nope');
    const failing = await api.checks!({ ...REF, headBranch: 'nope' });
    expect(failing).toEqual({ supported: true, green: false, state: 'failing' });
  });

  it('checks: a successful run on the head branch is green', async () => {
    startCiRun(mocks.doc.current!, 'dev');
    await expect(api.checks!(REF)).resolves.toEqual({ supported: true, green: true, state: 'green' });
  });

  it('checks: queued and running runs are pending, never failing', async () => {
    for (const status of ['queued', 'running'] as const) {
      mocks.doc.current!.ciRuns.unshift({
        id: `run-${status}`,
        branch: 'dev',
        status,
        log: '',
        createdAt: new Date().toISOString(),
      });
      await expect(api.checks!(REF)).resolves.toEqual({
        supported: true,
        green: false,
        state: 'pending',
      });
      mocks.doc.current!.ciRuns.length = 0;
    }
  });
});
