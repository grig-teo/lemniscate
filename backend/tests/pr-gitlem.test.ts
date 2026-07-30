import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyGitlemDoc,
  openPullRequest,
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
}));

// Reads always reflect the current in-memory doc; writes inside the
// transaction replace it (mirrors the real read-modify-write row update).
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    gitlemUser: { findUnique: mocks.userFindUnique },
    gitlemRepository: {
      findUnique: async () => ({ id: 'repo-1', doc: JSON.stringify(mocks.doc.current) }),
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

const api = gitlemPrApi({ provider: 'gitlem', baseUrl: null, accessTokenEnc: null });
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
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1' });
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
    mocks.userFindUnique.mockResolvedValue(null);
    await expect(api.open({ ...REF, title: 't', body: '' })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('gitlemPrApi.merge / state / list', () => {
  it('merges the open PR for the head branch and reports the state', async () => {
    await api.open({ ...REF, title: 'Add feature', body: '' });
    const merged = await api.merge(REF);
    expect(merged).toEqual({ merged: true, prUrl: '/gitlem/repos/alice/demo/pulls/1' });
    await expect(api.state(REF)).resolves.toBe('merged');
  });

  it('close marks the PR closed without merging', async () => {
    await api.open({ ...REF, title: 'Add feature', body: '' });
    await api.close(REF);
    await expect(api.state(REF)).resolves.toBe('closed');
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
});
