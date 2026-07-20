import { describe, expect, it } from 'vitest';

import { groupByConnection } from '@/lib/group-repos';
import type { Repository } from '@/lib/hooks';

function makeRepo(id: string, connectionId: string, provider: 'github' | 'gitlab' | 'gitverse', username: string): Repository {
  return {
    id,
    connectionId,
    externalId: id,
    name: id,
    fullName: `${username}/${id}`,
    cloneUrl: '',
    defaultBranch: 'main',
    autoPropose: false,
    autoCreatePr: false,
    autoReviewPr: false,
    autoMergePr: false,
    connection: { provider, username },
  };
}

describe('groupByConnection', () => {
  it('groups repos by connection preserving in-connection order', () => {
    const groups = groupByConnection([
      makeRepo('r1', 'c1', 'github', 'ann'),
      makeRepo('r2', 'c1', 'github', 'ann'),
      makeRepo('r3', 'c2', 'gitlab', 'bob'),
    ]);
    expect(groups).toHaveLength(2);
    const github = groups.find((g) => g.connectionId === 'c1');
    expect(github?.repos.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(github?.provider).toBe('github');
    expect(github?.username).toBe('ann');
  });

  it('sorts groups by provider name', () => {
    const groups = groupByConnection([
      makeRepo('r1', 'c1', 'gitverse', 'ann'),
      makeRepo('r2', 'c2', 'github', 'bob'),
    ]);
    expect(groups.map((g) => g.provider)).toEqual(['github', 'gitverse']);
  });

  it('returns an empty list for no repos', () => {
    expect(groupByConnection([])).toEqual([]);
  });
});
