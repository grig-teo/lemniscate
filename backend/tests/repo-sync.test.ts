import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitConnection } from '@prisma/client';
import type { NormalizedRepo } from '../src/lib/git-providers.js';

// Tests for syncConnectionRepositories: after each repo upsert the bare-repo
// flag is refreshed from the provider's root listing. The check is
// best-effort per repo — a failed probe leaves the previously stored value.

const mocks = vi.hoisted(() => ({
  listRepos: vi.fn(),
  isBare: vi.fn(),
  repoFindUnique: vi.fn(),
  repoUpsert: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    repository: { findUnique: mocks.repoFindUnique, upsert: mocks.repoUpsert },
  },
}));
vi.mock('../src/lib/git-providers.js', () => ({
  getProviderClient: () => ({ listRepos: mocks.listRepos, isBare: mocks.isBare }),
}));

import { syncConnectionRepositories } from '../src/lib/repo-sync.js';

const connection = { id: 'conn-1' } as GitConnection;

function repo(name: string): NormalizedRepo {
  return {
    externalId: `ext-${name}`,
    name,
    fullName: `ivan/${name}`,
    cloneUrl: `https://example.com/ivan/${name}.git`,
    defaultBranch: 'main',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repoFindUnique.mockResolvedValue(null);
  mocks.repoUpsert.mockResolvedValue({});
});

describe('syncConnectionRepositories bare flag', () => {
  it('stores the bare flag from the provider check on create and update', async () => {
    mocks.listRepos.mockResolvedValue([repo('empty')]);
    mocks.isBare.mockResolvedValue(true);
    await syncConnectionRepositories(connection);
    expect(mocks.isBare).toHaveBeenCalledWith('ivan/empty');
    const upsert = mocks.repoUpsert.mock.calls[0]?.[0];
    expect(upsert.create).toMatchObject({ fullName: 'ivan/empty', bare: true });
    expect(upsert.update).toMatchObject({ bare: true });
  });

  it('clears the flag when the repo gained implementation files', async () => {
    mocks.listRepos.mockResolvedValue([repo('code')]);
    mocks.isBare.mockResolvedValue(false);
    await syncConnectionRepositories(connection);
    expect(mocks.repoUpsert.mock.calls[0]?.[0].update).toMatchObject({ bare: false });
  });

  it('leaves the previous value when the bare check fails', async () => {
    mocks.listRepos.mockResolvedValue([repo('flaky')]);
    mocks.isBare.mockRejectedValue(new Error('boom'));
    const result = await syncConnectionRepositories(connection);
    const upsert = mocks.repoUpsert.mock.calls[0]?.[0];
    expect(upsert.create).not.toHaveProperty('bare');
    expect(upsert.update).not.toHaveProperty('bare');
    expect(result).toEqual({ synced: 1, created: 1, updated: 0 });
  });

  it('checks each repo independently and keeps counting created/updated', async () => {
    mocks.listRepos.mockResolvedValue([repo('old'), repo('new')]);
    mocks.isBare.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('boom'));
    mocks.repoFindUnique.mockResolvedValueOnce({ id: 'repo-old' }).mockResolvedValueOnce(null);
    const result = await syncConnectionRepositories(connection);
    expect(mocks.repoUpsert.mock.calls[0]?.[0].update).toMatchObject({ bare: true });
    expect(mocks.repoUpsert.mock.calls[1]?.[0].update).not.toHaveProperty('bare');
    expect(result).toEqual({ synced: 2, created: 1, updated: 1 });
  });
});
