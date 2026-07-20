import { afterEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/lib/crypto.js';
import { ProviderError } from '../src/lib/git-providers.js';
import {
  assembleUnifiedDiff,
  createOrFindExistingPr,
  getPullRequestDiff,
  mergePullRequest,
  openPullRequest,
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
