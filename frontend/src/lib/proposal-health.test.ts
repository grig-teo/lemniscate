import { describe, expect, it, vi } from 'vitest';

import { proposalHealth, HEALTH_LABELS } from '@/lib/proposal-health';
import type { Repository } from '@/lib/hooks';

vi.mock('@', () => ({}));

function makeRepo(over: Partial<Repository>): Repository {
  return {
    id: 'r1',
    connectionId: 'c1',
    externalId: 'r1',
    name: 'repo',
    fullName: 'owner/repo',
    cloneUrl: '',
    defaultBranch: 'main',
    autoPropose: true,
    autoCreatePr: true,
    autoReviewPr: false,
    autoMergePr: false,
    autoRunProposals: false,
    hidden: false,
    bare: false,
    connection: { provider: 'github', username: 'owner' },
    ...over,
  } as Repository;
}

describe('proposalHealth', () => {
  it('returns red when lastProposalError is set', () => {
    const repo = makeRepo({ lastProposalError: 'LLM down' });
    expect(proposalHealth(repo)).toBe('red');
  });

  it('returns green when lastProposalAt is recent', () => {
    const repo = makeRepo({ lastProposalAt: new Date().toISOString() });
    expect(proposalHealth(repo)).toBe('green');
  });

  it('returns amber when lastProposalAt is older than 1 day', () => {
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const repo = makeRepo({ lastProposalAt: stale });
    expect(proposalHealth(repo)).toBe('amber');
  });

  it('returns none when never run and no error', () => {
    const repo = makeRepo({ lastProposalAt: null, lastProposalError: null });
    expect(proposalHealth(repo)).toBe('none');
  });

  it('returns none when autoPropose and autoRunProposals are both off', () => {
    const repo = makeRepo({
      autoPropose: false,
      autoRunProposals: false,
      lastProposalError: 'boom',
    });
    expect(proposalHealth(repo)).toBe('none');
  });

  it('shows health when autoRunProposals is on even if autoPropose is off', () => {
    const repo = makeRepo({
      autoPropose: false,
      autoRunProposals: true,
      lastProposalError: 'boom',
    });
    expect(proposalHealth(repo)).toBe('red');
  });

  it('HEALTH_LABELS covers all statuses', () => {
    for (const key of ['red', 'amber', 'green', 'none'] as const) {
      expect(HEALTH_LABELS[key]).toBeDefined();
    }
  });
});
