import { afterEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/lib/crypto.js';
import { ProviderError } from '../src/lib/git-providers.js';
import {
  assembleUnifiedDiff,
  createOrFindExistingPr,
  getPullRequestDiff,
  listPrReviewComments,
  listPullRequests,
  mergePullRequest,
  openPullRequest,
  prStateFromOpenMerged,
  prStateFromString,
  pullRequestChecksStatus,
  pullRequestState,
} from '../src/lib/pull-requests.js';

// Locking tests for the "open PR → on already-exists status, look up the
// existing one" recovery flow that was copy-pasted across the github,
// gitlab, and gitverse openPullRequest implementations.

const alreadyExists = new ProviderError('conflict', 409);
const serverError = new ProviderError('boom', 500);

describe('createOrFindExistingPr', () => {
  it('returns the created PR url without calling the lookup', async () => {
    const result = await createOrFindExistingPr({
      create: async () => 'https://pr/1',
      alreadyExistsStatuses: [409],
      findExisting: async () => {
        throw new Error('must not be called');
      },
    });
    expect(result).toEqual({ prUrl: 'https://pr/1' });
  });

  it('recovers the existing PR url on an already-exists status', async () => {
    const result = await createOrFindExistingPr({
      create: async () => {
        throw alreadyExists;
      },
      alreadyExistsStatuses: [409],
      findExisting: async () => 'https://pr/existing',
    });
    expect(result).toEqual({ prUrl: 'https://pr/existing' });
  });

  it('rethrows the original error when no existing PR is found', async () => {
    await expect(
      createOrFindExistingPr({
        create: async () => {
          throw alreadyExists;
        },
        alreadyExistsStatuses: [409],
        findExisting: async () => null,
      }),
    ).rejects.toBe(alreadyExists);
  });

  it('rethrows non-matching statuses without calling the lookup', async () => {
    await expect(
      createOrFindExistingPr({
        create: async () => {
          throw serverError;
        },
        alreadyExistsStatuses: [409],
        findExisting: async () => 'https://pr/existing',
      }),
    ).rejects.toBe(serverError);
  });

  it('rethrows non-ProviderError failures', async () => {
    const err = new TypeError('nope');
    await expect(
      createOrFindExistingPr({
        create: async () => {
          throw err;
        },
        alreadyExistsStatuses: [409],
        findExisting: async () => 'https://pr/existing',
      }),
    ).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// GitVerse provider (mocked fetch, no network)
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => text,
  } as unknown as Response;
}

type FetchHandler = (url: string, init?: RequestInit) => Response;

function stubFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const fn = vi.fn((input: unknown, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const gvConnection = {
  provider: 'gitverse' as const,
  baseUrl: null,
  accessTokenEnc: encrypt('tok'),
};
const gvInput = {
  repoFullName: 'ivan/repo',
  headBranch: 'lemniscate/t-1',
  baseBranch: 'main',
  title: 'Title',
  body: 'Body',
};
const gvRef = {
  repoFullName: gvInput.repoFullName,
  headBranch: gvInput.headBranch,
  baseBranch: gvInput.baseBranch,
};
const gvPull = {
  number: 7,
  html_url: 'https://gitverse.ru/ivan/repo/pulls/7',
  head: { ref: gvInput.headBranch },
  base: { ref: gvInput.baseBranch },
};
const pullsUrl = 'https://api.gitverse.ru/repos/ivan/repo/pulls';

describe('assembleUnifiedDiff', () => {
  it('assembles a unified diff from per-file patches', () => {
    const diff = assembleUnifiedDiff([
      { filename: 'a.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
      { filename: 'b.ts', previous_filename: 'old-b.ts', patch: '@@ -0 +1 @@\n+x' },
    ]);
    expect(diff).toBe(
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' +
        'diff --git a/old-b.ts b/b.ts\n--- a/old-b.ts\n+++ b/b.ts\n@@ -0 +1 @@\n+x',
    );
  });

  it('tolerates files without a patch', () => {
    expect(assembleUnifiedDiff([{ filename: 'bin.png' }])).toBe(
      'diff --git a/bin.png b/bin.png\n--- a/bin.png\n+++ b/bin.png\n',
    );
  });
});

describe('gitverse openPullRequest', () => {
  it('creates the PR via POST /repos/{full}/pulls', async () => {
    const fetchMock = stubFetch((url, init) => {
      expect(url).toBe(pullsUrl);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        title: 'Title',
        body: 'Body',
        head: gvInput.headBranch,
        base: gvInput.baseBranch,
      });
      return mockResponse(201, gvPull);
    });
    const result = await openPullRequest(gvConnection, gvInput);
    expect(result).toEqual({ prUrl: gvPull.html_url });
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers.Accept).toBe('application/vnd.gitverse.object+json;version=1');
  });

  it('falls back to the web URL when html_url is missing', async () => {
    stubFetch(() => mockResponse(201, { number: 9 }));
    const result = await openPullRequest(gvConnection, gvInput);
    expect(result).toEqual({ prUrl: 'https://gitverse.ru/ivan/repo/pulls/9' });
  });

  it('recovers the existing PR on a 409 conflict', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'POST') return mockResponse(409, { message: 'pull request already exists' });
      expect(url).toContain('state=open');
      return mockResponse(200, [gvPull]);
    });
    const result = await openPullRequest(gvConnection, gvInput);
    expect(result).toEqual({ prUrl: gvPull.html_url });
  });

  it('recovers the existing PR on a 422', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'POST') return mockResponse(422, { message: 'validation failed' });
      return mockResponse(200, [gvPull]);
    });
    const result = await openPullRequest(gvConnection, gvInput);
    expect(result).toEqual({ prUrl: gvPull.html_url });
  });
});

describe('gitverse getPullRequestDiff', () => {
  it('assembles the diff from the compare endpoint', async () => {
    stubFetch((url) => {
      expect(url).toBe(
        'https://api.gitverse.ru/repos/ivan/repo/compare/main...lemniscate/t-1',
      );
      return mockResponse(200, { files: [{ filename: 'a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }] });
    });
    const diff = await getPullRequestDiff(gvConnection, gvRef);
    expect(diff).toBe('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b');
  });

  it('falls back to the PR files endpoint when compare fails', async () => {
    stubFetch((url) => {
      if (url.includes('/compare/')) return mockResponse(404, { message: 'not found' });
      if (url.includes('state=open')) return mockResponse(200, [gvPull]);
      expect(url).toBe(`${pullsUrl}/7/files`);
      return mockResponse(200, [{ filename: 'c.ts', patch: '@@ -1 +1 @@\n-c\n+d' }]);
    });
    const diff = await getPullRequestDiff(gvConnection, gvRef);
    expect(diff).toContain('diff --git a/c.ts b/c.ts');
  });
});

describe('gitverse mergePullRequest', () => {
  it('merges via PUT /pulls/{n}/merge', async () => {
    stubFetch((url, init) => {
      if (url.includes('state=open')) return mockResponse(200, [gvPull]);
      expect(url).toBe(`${pullsUrl}/7/merge`);
      expect(init?.method).toBe('PUT');
      return mockResponse(200, { merged: true });
    });
    const result = await mergePullRequest(gvConnection, gvRef);
    expect(result).toEqual({ merged: true, prUrl: gvPull.html_url });
  });

  it('throws a clear unsupported error when the endpoint does not exist', async () => {
    stubFetch((url, init) => {
      if (url.includes('state=open')) return mockResponse(200, [gvPull]);
      expect(init?.method).toBe('PUT');
      return mockResponse(404, { message: 'not found' });
    });
    await expect(mergePullRequest(gvConnection, gvRef)).rejects.toThrow(
      /merge via API is not supported/,
    );
  });

  it('reports a conflict when the status check says mergeable=false', async () => {
    stubFetch((url, init) => {
      if (url.includes('state=open')) return mockResponse(200, [gvPull]);
      if (init?.method === 'PUT') return mockResponse(409, { message: 'cannot merge' });
      // GET /pulls/{n}/merge status check
      return mockResponse(200, { mergeable: false });
    });
    const result = await mergePullRequest(gvConnection, gvRef);
    expect(result).toEqual({ merged: false, conflict: true, prUrl: gvPull.html_url });
  });

  it('rethrows a 409 that cannot be confirmed as a conflict', async () => {
    stubFetch((url, init) => {
      if (url.includes('state=open')) return mockResponse(200, [gvPull]);
      if (init?.method === 'PUT') return mockResponse(409, { message: 'head changed' });
      return mockResponse(404, { message: 'no status check' });
    });
    const error = await mergePullRequest(gvConnection, gvRef).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(409);
  });
});

describe('gitverse listPrReviewComments', () => {
  // The Gitea-flavored API (pinned e2e image gitea/gitea:1.26.4) has NO
  // GET /pulls/{n}/comments — it 404s. Review comments are fetched per
  // review: GET /pulls/{n}/reviews, then GET /pulls/{n}/reviews/{id}/comments.
  it('collects review comments across reviews via the per-review endpoints', async () => {
    stubFetch((url) => {
      if (url.includes('state=open')) return mockResponse(200, [gvPull]);
      if (url === `${pullsUrl}/7/reviews?per_page=100`) {
        return mockResponse(200, [{ id: 11 }, { id: 12 }]);
      }
      if (url === `${pullsUrl}/7/reviews/11/comments?per_page=100`) {
        return mockResponse(200, [
          {
            id: 101,
            body: 'please document the marker file',
            user: { login: 'e2e-reviewer' },
            path: 'E2E_SMOKE.md',
            position: 1,
          },
        ]);
      }
      if (url === `${pullsUrl}/7/reviews/12/comments?per_page=100`) {
        return mockResponse(200, [
          { id: 102, body: 'and rename it', user: { login: 'e2e-reviewer' }, path: 'x.md' },
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    });
    const comments = await listPrReviewComments(gvConnection, gvRef);
    expect(comments).toEqual([
      { id: 'rc-101', body: 'please document the marker file', author: 'e2e-reviewer', path: 'E2E_SMOKE.md' },
      { id: 'rc-102', body: 'and rename it', author: 'e2e-reviewer', path: 'x.md' },
    ]);
  });

  it('reports no comments when the PR has no reviews', async () => {
    stubFetch((url) => {
      if (url.includes('state=open')) return mockResponse(200, [gvPull]);
      expect(url).toBe(`${pullsUrl}/7/reviews?per_page=100`);
      return mockResponse(200, []);
    });
    await expect(listPrReviewComments(gvConnection, gvRef)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Provider API URL path encoding
// ---------------------------------------------------------------------------

const ghConnection = {
  provider: 'github' as const,
  baseUrl: null,
  accessTokenEnc: encrypt('tok'),
};
const oddNameInput = { ...gvInput, repoFullName: 'my org/re.po' };

describe('provider API URL path encoding', () => {
  it('encodes each repoFullName segment for github', async () => {
    stubFetch((url) => {
      expect(url).toBe('https://api.github.com/repos/my%20org/re.po/pulls');
      return mockResponse(201, { html_url: 'https://github.com/x/pulls/1' });
    });
    await openPullRequest(ghConnection, oddNameInput);
  });

  it('encodes each repoFullName segment for gitverse', async () => {
    stubFetch((url) => {
      expect(url).toBe('https://api.gitverse.ru/repos/my%20org/re.po/pulls');
      return mockResponse(201, { number: 1, html_url: 'https://gitverse.ru/x/pulls/1' });
    });
    await openPullRequest(gvConnection, oddNameInput);
  });

  it('encodes each repoFullName segment for gitee', async () => {
    stubFetch((url) => {
      expect(url).toBe('https://gitee.com/api/v5/repos/my%20org/re.po/pulls');
      return mockResponse(201, { number: 1, html_url: 'https://gitee.com/x/pulls/1' });
    });
    await openPullRequest(giteeConnection, oddNameInput);
  });

  it('encodes segments in the gitverse compare URL', async () => {
    stubFetch((url) => {
      expect(url).toBe(
        'https://api.gitverse.ru/repos/my%20org/re.po/compare/main...lemniscate/t-1',
      );
      return mockResponse(200, { files: [] });
    });
    await getPullRequestDiff(gvConnection, { ...gvRef, repoFullName: 'my org/re.po' });
  });
});

// ---------------------------------------------------------------------------
// Gitee provider (mocked fetch, no network)
// ---------------------------------------------------------------------------

const giteeConnection = {
  provider: 'gitee' as const,
  baseUrl: null,
  accessTokenEnc: encrypt('tok'),
};
const giteePull = {
  number: 3,
  html_url: 'https://gitee.com/ivan/repo/pulls/3',
  head: { ref: gvInput.headBranch },
  base: { ref: gvInput.baseBranch },
};
const giteePullsUrl = 'https://gitee.com/api/v5/repos/ivan/repo/pulls';

describe('gitee openPullRequest', () => {
  it('creates the PR via POST /repos/{full}/pulls', async () => {
    const fetchMock = stubFetch((url, init) => {
      expect(url).toBe(giteePullsUrl);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        title: 'Title',
        head: gvInput.headBranch,
        base: gvInput.baseBranch,
        body: 'Body',
      });
      return mockResponse(201, giteePull);
    });
    const result = await openPullRequest(giteeConnection, gvInput);
    expect(result).toEqual({ prUrl: giteePull.html_url });
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it('recovers the existing PR on a 409 conflict', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'POST') return mockResponse(409, { message: 'pull request already exists' });
      expect(url).toContain('state=open');
      return mockResponse(200, [giteePull]);
    });
    const result = await openPullRequest(giteeConnection, gvInput);
    expect(result).toEqual({ prUrl: giteePull.html_url });
  });
});

describe('gitee mergePullRequest', () => {
  it('merges via PUT /pulls/{n}/merge', async () => {
    stubFetch((url, init) => {
      if (url.includes('state=open')) return mockResponse(200, [giteePull]);
      expect(url).toBe(`${giteePullsUrl}/3/merge`);
      expect(init?.method).toBe('PUT');
      return mockResponse(200, { merged: true });
    });
    const result = await mergePullRequest(giteeConnection, gvRef);
    expect(result).toEqual({ merged: true, prUrl: giteePull.html_url });
  });

  it('reports a conflict on a merge refusal status', async () => {
    stubFetch((url, init) => {
      if (url.includes('state=open')) return mockResponse(200, [giteePull]);
      expect(init?.method).toBe('PUT');
      return mockResponse(405, { message: 'not mergeable' });
    });
    const result = await mergePullRequest(giteeConnection, gvRef);
    expect(result).toEqual({ merged: false, conflict: true, prUrl: giteePull.html_url });
  });
});

describe('gitee getPullRequestDiff', () => {
  it('assembles the diff from the PR files endpoint', async () => {
    stubFetch((url) => {
      if (url.includes('state=open')) return mockResponse(200, [giteePull]);
      expect(url).toBe(`${giteePullsUrl}/3/files`);
      return mockResponse(200, [{ filename: 'a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }]);
    });
    const diff = await getPullRequestDiff(giteeConnection, gvRef);
    expect(diff).toBe('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b');
  });
});

// ---------------------------------------------------------------------------
// Auto-merge gate: provider check statuses
// ---------------------------------------------------------------------------

const gitlabConnection = {
  provider: 'gitlab' as const,
  baseUrl: null,
  accessTokenEnc: encrypt('tok'),
  tokenType: 'pat',
};

describe('pullRequestChecksStatus', () => {
  // GitHub CI signal = combined commit status AND check runs (GitHub
  // Actions reports only to check runs — see tests/pr-github.test.ts).
  const githubStatusUrl =
    'https://api.github.com/repos/ivan/repo/commits/lemniscate%2Ft-1/status';
  const githubCheckRunsUrl =
    'https://api.github.com/repos/ivan/repo/commits/lemniscate%2Ft-1/check-runs?filter=latest&per_page=100';

  function stubGithubChecks(combined: unknown, checkRuns: unknown[] = []) {
    stubFetch((url) => {
      if (url === githubStatusUrl) return mockResponse(200, combined);
      expect(url).toBe(githubCheckRunsUrl);
      return mockResponse(200, { total_count: checkRuns.length, check_runs: checkRuns });
    });
  }

  it('github: green when the combined commit status is success', async () => {
    stubGithubChecks({ state: 'success', total_count: 2 });
    const status = await pullRequestChecksStatus(ghConnection, gvRef);
    expect(status).toMatchObject({ supported: true, green: true, state: 'green' });
  });

  it('github: green when the commit has no checks at all', async () => {
    stubGithubChecks({ state: 'pending', total_count: 0 });
    const status = await pullRequestChecksStatus(ghConnection, gvRef);
    expect(status).toMatchObject({ supported: true, green: true, state: 'green' });
  });

  it('github: failing when checks failed', async () => {
    stubGithubChecks({ state: 'failure', total_count: 3 });
    const status = await pullRequestChecksStatus(ghConnection, gvRef);
    expect(status).toMatchObject({ supported: true, green: false, state: 'failing' });
  });

  it('github: pending while checks are still running', async () => {
    stubGithubChecks({ state: 'pending', total_count: 2 });
    const status = await pullRequestChecksStatus(ghConnection, gvRef);
    expect(status).toMatchObject({ supported: true, green: false, state: 'pending' });
  });

  it('github: failing when an Actions check run failed despite zero commit statuses', async () => {
    // The live-observed regression: Actions-only repo reports total_count 0
    // on the status endpoint — the gate merged red PRs as "green".
    stubGithubChecks({ state: 'pending', total_count: 0 }, [
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
    ]);
    const status = await pullRequestChecksStatus(ghConnection, gvRef);
    expect(status).toMatchObject({ supported: true, green: false, state: 'failing' });
  });

  it('github: pending while an Actions check run is still in progress', async () => {
    stubGithubChecks({ state: 'pending', total_count: 0 }, [
      { status: 'in_progress', conclusion: null },
    ]);
    const status = await pullRequestChecksStatus(ghConnection, gvRef);
    expect(status).toMatchObject({ supported: true, green: false, state: 'pending' });
  });

  it('gitlab: green when the MR has no head pipeline', async () => {
    stubFetch((url) => {
      if (url.includes('state=opened')) return mockResponse(200, [{ iid: 5, web_url: 'https://gitlab.com/ivan/repo/-/merge_requests/5' }]);
      expect(url).toBe('https://gitlab.com/api/v4/projects/ivan%2Frepo/merge_requests/5');
      return mockResponse(200, { head_pipeline: null });
    });
    const status = await pullRequestChecksStatus(gitlabConnection, gvRef);
    expect(status).toMatchObject({ supported: true, green: true, state: 'green' });
  });

  it('gitlab: not green when the head pipeline failed', async () => {
    stubFetch((url) => {
      if (url.includes('state=opened')) return mockResponse(200, [{ iid: 5, web_url: 'u' }]);
      return mockResponse(200, { head_pipeline: { status: 'failed' } });
    });
    const status = await pullRequestChecksStatus(gitlabConnection, gvRef);
    expect(status).toMatchObject({ supported: true, green: false, state: 'failing' });
  });

  it('gitlab: pending while the head pipeline is running', async () => {
    stubFetch((url) => {
      if (url.includes('state=opened')) return mockResponse(200, [{ iid: 5, web_url: 'u' }]);
      return mockResponse(200, { head_pipeline: { status: 'running' } });
    });
    const status = await pullRequestChecksStatus(gitlabConnection, gvRef);
    expect(status).toMatchObject({ supported: true, green: false, state: 'pending' });
  });

  it('reports unsupported for providers without a checks API', async () => {
    const fetchMock = stubFetch(() => mockResponse(500, {}));
    expect(await pullRequestChecksStatus(gvConnection, gvRef)).toEqual({
      supported: false,
      green: true,
      state: 'green',
    });
    expect(await pullRequestChecksStatus(giteeConnection, gvRef)).toEqual({
      supported: false,
      green: true,
      state: 'green',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PR state polling (pr-state-sync job)
// ---------------------------------------------------------------------------

describe('prStateFromString / prStateFromOpenMerged', () => {
  it('maps provider state strings to open/merged/closed', () => {
    expect(prStateFromString('merged')).toBe('merged');
    expect(prStateFromString('open')).toBe('open');
    expect(prStateFromString('opened')).toBe('open');
    expect(prStateFromString('closed')).toBe('closed');
    expect(prStateFromString('locked')).toBe('closed');
  });

  it('merged flag wins over a closed state', () => {
    expect(prStateFromOpenMerged('closed', true)).toBe('merged');
    expect(prStateFromOpenMerged('closed', false)).toBe('closed');
    expect(prStateFromOpenMerged('open', false)).toBe('open');
  });
});

describe('pullRequestState', () => {
  it('github: merged when the PR detail reports merged', async () => {
    stubFetch((url) => {
      if (url.includes('state=all')) {
        return mockResponse(200, [{ number: 7, base: { ref: 'main' } }]);
      }
      expect(url).toBe('https://api.github.com/repos/ivan/repo/pulls/7');
      return mockResponse(200, { state: 'closed', merged: true });
    });
    expect(await pullRequestState(ghConnection, gvRef)).toBe('merged');
  });

  it('github: open when the PR is still open', async () => {
    stubFetch((url) => {
      if (url.includes('state=all')) {
        return mockResponse(200, [{ number: 7, base: { ref: 'main' } }]);
      }
      return mockResponse(200, { state: 'open', merged: false });
    });
    expect(await pullRequestState(ghConnection, gvRef)).toBe('open');
  });

  it('github: throws when no PR exists for the branch pair', async () => {
    stubFetch(() => mockResponse(200, []));
    await expect(pullRequestState(ghConnection, gvRef)).rejects.toThrow('no pull request');
  });

  it('gitlab: maps the MR state from the state=all list', async () => {
    stubFetch((url) => {
      expect(url).toBe(
        'https://gitlab.com/api/v4/projects/ivan%2Frepo/merge_requests' +
          '?state=all&source_branch=lemniscate%2Ft-1&target_branch=main',
      );
      return mockResponse(200, [{ state: 'merged' }]);
    });
    expect(await pullRequestState(gitlabConnection, gvRef)).toBe('merged');
  });

  it('gitverse: merged via merged_at on the PR detail', async () => {
    stubFetch((url) => {
      if (url.includes('state=all')) return mockResponse(200, [gvPull]);
      expect(url).toBe('https://api.gitverse.ru/repos/ivan/repo/pulls/7');
      return mockResponse(200, { state: 'closed', merged_at: '2026-01-01T00:00:00Z' });
    });
    expect(await pullRequestState(gvConnection, gvRef)).toBe('merged');
  });

  it('gitee: maps the PR state from the state=all list', async () => {
    stubFetch((url) => {
      expect(url).toContain('state=all');
      return mockResponse(200, [
        { state: 'closed', head: { ref: gvRef.headBranch }, base: { ref: 'main' } },
      ]);
    });
    expect(await pullRequestState(giteeConnection, gvRef)).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// Batched per-repo PR listing (pr-state-sync job)
// ---------------------------------------------------------------------------

describe('listPullRequests', () => {
  const ghListUrl = 'https://api.github.com/repos/ivan/repo/pulls';

  it('github: maps the state=all list, merged via merged_at', async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toBe(`${ghListUrl}?state=all&per_page=100&page=1`);
      return mockResponse(200, [
        { state: 'closed', merged_at: '2026-01-01T00:00:00Z', head: { ref: 'a' }, base: { ref: 'main' } },
        { state: 'open', merged_at: null, head: { ref: 'b' }, base: { ref: 'main' } },
        { state: 'closed', merged_at: null, head: { ref: 'c' }, base: { ref: 'dev' } },
      ]);
    });
    expect(await listPullRequests(ghConnection, 'ivan/repo')).toEqual([
      { headBranch: 'a', baseBranch: 'main', state: 'merged' },
      { headBranch: 'b', baseBranch: 'main', state: 'open' },
      { headBranch: 'c', baseBranch: 'dev', state: 'closed' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('github: paginates while pages are full, capped at three pages', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      state: 'open',
      merged_at: null,
      head: { ref: `b${i}` },
      base: { ref: 'main' },
    }));
    const fetchMock = stubFetch(() => mockResponse(200, fullPage));
    const pulls = await listPullRequests(ghConnection, 'ivan/repo');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(pulls).toHaveLength(300);
  });

  it('gitlab: maps source/target branches and the MR state', async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toBe(
        'https://gitlab.com/api/v4/projects/ivan%2Frepo/merge_requests' +
          '?state=all&per_page=100&page=1',
      );
      return mockResponse(200, [
        { state: 'merged', source_branch: 'a', target_branch: 'main' },
        { state: 'opened', source_branch: 'b', target_branch: 'main' },
      ]);
    });
    expect(await listPullRequests(gitlabConnection, 'ivan/repo')).toEqual([
      { headBranch: 'a', baseBranch: 'main', state: 'merged' },
      { headBranch: 'b', baseBranch: 'main', state: 'open' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gitverse: maps merged via merged_at on the list payload', async () => {
    stubFetch((url) => {
      expect(url).toBe(`${pullsUrl}?state=all&per_page=100&page=1`);
      return mockResponse(200, [
        { state: 'closed', merged_at: '2026-01-01T00:00:00Z', head: { ref: 'a' }, base: { ref: 'main' } },
      ]);
    });
    expect(await listPullRequests(gvConnection, 'ivan/repo')).toEqual([
      { headBranch: 'a', baseBranch: 'main', state: 'merged' },
    ]);
  });

  it('gitee: maps head/base refs and the PR state', async () => {
    stubFetch((url) => {
      expect(url).toBe(`${giteePullsUrl}?state=all&per_page=100&page=1`);
      return mockResponse(200, [
        { state: 'closed', head: { ref: 'a' }, base: { ref: 'main' } },
      ]);
    });
    expect(await listPullRequests(giteeConnection, 'ivan/repo')).toEqual([
      { headBranch: 'a', baseBranch: 'main', state: 'closed' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Characterization tests locking github/gitlab open/merge/diff behavior
// before the module split (AGENTS.md section 7: locking test first).
// ---------------------------------------------------------------------------

const ghPullsUrl = 'https://api.github.com/repos/ivan/repo/pulls';
const ghOpenPullsQuery =
  `${ghPullsUrl}?state=open&head=${encodeURIComponent('ivan:lemniscate/t-1')}&per_page=100`;
const ghLookupPull = { number: 7, html_url: 'https://github.com/ivan/repo/pull/7', base: { ref: 'main' } };

describe('github openPullRequest', () => {
  it('creates the PR via POST /repos/{full}/pulls', async () => {
    stubFetch((url, init) => {
      expect(url).toBe(ghPullsUrl);
      expect(init?.method).toBe('POST');
      return mockResponse(201, { html_url: 'https://github.com/ivan/repo/pull/1' });
    });
    const result = await openPullRequest(ghConnection, gvInput);
    expect(result).toEqual({ prUrl: 'https://github.com/ivan/repo/pull/1' });
  });

  it('recovers the existing PR on a 422 already-exists response', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'POST') return mockResponse(422, { message: 'Validation Failed' });
      expect(url).toBe(ghOpenPullsQuery);
      return mockResponse(200, [{ html_url: 'https://github.com/ivan/repo/pull/9', base: { ref: 'main' } }]);
    });
    const result = await openPullRequest(ghConnection, gvInput);
    expect(result).toEqual({ prUrl: 'https://github.com/ivan/repo/pull/9' });
  });
});

describe('github mergePullRequest', () => {
  it('merges via PUT /pulls/{number}/merge', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'PUT') {
        expect(url).toBe(`${ghPullsUrl}/7/merge`);
        return mockResponse(200, { merged: true });
      }
      expect(url).toBe(ghOpenPullsQuery);
      return mockResponse(200, [ghLookupPull]);
    });
    const result = await mergePullRequest(ghConnection, gvRef);
    expect(result).toEqual({ merged: true, prUrl: ghLookupPull.html_url });
  });

  it('maps a 405 refusal to a conflict result', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'PUT') return mockResponse(405, { message: 'Not mergeable' });
      return mockResponse(200, [ghLookupPull]);
    });
    const result = await mergePullRequest(ghConnection, gvRef);
    expect(result).toEqual({ merged: false, conflict: true, prUrl: ghLookupPull.html_url });
  });
});

describe('github getPullRequestDiff', () => {
  it('fetches the diff with the github diff Accept header', async () => {
    stubFetch((url, init) => {
      if (url === ghOpenPullsQuery) return mockResponse(200, [ghLookupPull]);
      expect(url).toBe(`${ghPullsUrl}/7`);
      expect((init?.headers as Record<string, string>).Accept).toBe('application/vnd.github.diff');
      return mockResponse(200, 'diff --git a/f b/f');
    });
    expect(await getPullRequestDiff(ghConnection, gvRef)).toBe('diff --git a/f b/f');
  });
});

const glMrsUrl = 'https://gitlab.com/api/v4/projects/ivan%2Frepo/merge_requests';
const glOpenedMrsQuery =
  `${glMrsUrl}?state=opened&source_branch=lemniscate%2Ft-1&target_branch=main`;

describe('gitlab openPullRequest', () => {
  it('creates the MR via POST /projects/{full}/merge_requests', async () => {
    stubFetch((url, init) => {
      expect(url).toBe(glMrsUrl);
      expect(init?.method).toBe('POST');
      return mockResponse(201, { web_url: 'https://gitlab.com/ivan/repo/-/merge_requests/1' });
    });
    const result = await openPullRequest(gitlabConnection, gvInput);
    expect(result).toEqual({ prUrl: 'https://gitlab.com/ivan/repo/-/merge_requests/1' });
  });

  it('recovers the existing MR on a 409 already-exists response', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'POST') return mockResponse(409, { message: 'MR exists' });
      expect(url).toBe(glOpenedMrsQuery);
      return mockResponse(200, [{ web_url: 'https://gitlab.com/ivan/repo/-/merge_requests/9' }]);
    });
    const result = await openPullRequest(gitlabConnection, gvInput);
    expect(result).toEqual({ prUrl: 'https://gitlab.com/ivan/repo/-/merge_requests/9' });
  });
});

describe('gitlab mergePullRequest', () => {
  it('merges via PUT /merge_requests/{iid}/merge', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'PUT') {
        expect(url).toBe(`${glMrsUrl}/5/merge`);
        return mockResponse(200, { state: 'merged' });
      }
      expect(url).toBe(glOpenedMrsQuery);
      return mockResponse(200, [{ iid: 5, web_url: 'https://gitlab.com/ivan/repo/-/merge_requests/5' }]);
    });
    const result = await mergePullRequest(gitlabConnection, gvRef);
    expect(result).toEqual({ merged: true, prUrl: 'https://gitlab.com/ivan/repo/-/merge_requests/5' });
  });

  it('maps a 406 refusal to a conflict result', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'PUT') return mockResponse(406, { message: 'Conflict' });
      return mockResponse(200, [{ iid: 5, web_url: 'w' }]);
    });
    const result = await mergePullRequest(gitlabConnection, gvRef);
    expect(result).toEqual({ merged: false, conflict: true, prUrl: 'w' });
  });
});

describe('gitlab getPullRequestDiff', () => {
  it('reassembles a unified diff from the MR changes payload', async () => {
    stubFetch((url) => {
      if (url === glOpenedMrsQuery) return mockResponse(200, [{ iid: 5, web_url: 'w' }]);
      expect(url).toBe(`${glMrsUrl}/5/changes`);
      return mockResponse(200, {
        changes: [{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@' }],
      });
    });
    expect(await getPullRequestDiff(gitlabConnection, gvRef)).toBe(
      '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@',
    );
  });
});
