import { describe, expect, it } from 'vitest';

import { initialFlags, REPO_FLAG_INFO, setAutoReview, type RepoFlags } from '@/lib/repo-flags';
import type { Repository } from '@/lib/hooks';

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'r1',
    connectionId: 'c1',
    externalId: 'e1',
    name: 'demo',
    fullName: 'org/demo',
    cloneUrl: 'https://example.com/org/demo.git',
    defaultBranch: 'main',
    autoPropose: false,
    autoCreatePr: false,
    autoReviewPr: true,
    autoMergePr: true,
    autoAddressReview: false,
    autoRunProposals: false,
    hidden: false,
    bare: false,
    connection: { provider: 'github', username: 'octo' },
    ...overrides,
  };
}

describe('setAutoReview', () => {
  it('turning review off also turns merge off — merging requires a review', () => {
    expect(setAutoReview({ autoMergePr: true }, false)).toEqual({
      autoReviewPr: false,
      autoMergePr: false,
    });
  });

  it('turning review on keeps merge unchanged', () => {
    expect(setAutoReview({ autoMergePr: true }, true)).toEqual({
      autoReviewPr: true,
      autoMergePr: true,
    });
    expect(setAutoReview({ autoMergePr: false }, true)).toEqual({
      autoReviewPr: true,
      autoMergePr: false,
    });
  });
});

describe('initialFlags', () => {
  it('defaults to PR on / everything else off when there are no repositories', () => {
    const defaults: RepoFlags = {
      autoCreatePr: true,
      autoReviewPr: false,
      autoMergePr: false,
      autoAddressReview: false,
    };
    expect(initialFlags(undefined)).toEqual(defaults);
    expect(initialFlags([])).toEqual(defaults);
  });

  it('takes the flags of the first repository', () => {
    const flags = initialFlags([
      makeRepo({ autoCreatePr: false, autoReviewPr: true, autoMergePr: true }),
      makeRepo({ id: 'r2', autoCreatePr: true, autoReviewPr: false, autoMergePr: false }),
    ]);
    expect(flags).toEqual({
      autoCreatePr: false,
      autoReviewPr: true,
      autoMergePr: true,
      autoAddressReview: false,
    });
  });
});

describe('REPO_FLAG_INFO', () => {
  it('covers every repository automation flag exactly once', () => {
    expect(REPO_FLAG_INFO.map((info) => info.key)).toEqual([
      'autoCreatePr',
      'autoReviewPr',
      'autoMergePr',
      'autoRunProposals',
      'autoAddressReview',
    ]);
  });

  it('has a non-empty label and description for each flag', () => {
    for (const info of REPO_FLAG_INFO) {
      expect(info.label.trim()).not.toBe('');
      expect(info.description.trim()).not.toBe('');
    }
  });
});
