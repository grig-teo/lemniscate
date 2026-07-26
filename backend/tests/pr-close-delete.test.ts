import { afterEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/lib/crypto.js';
import { ProviderError } from '../src/lib/git-providers.js';
import {
  closePullRequest,
  deleteBranch,
} from '../src/lib/pull-requests.js';

// Locking tests for the close + deleteBranch PR operations across providers
// (mocked fetch, no network). Each provider receives the same PullRequestRefInput
// and must call its own close/branch-delete endpoint with the right shape.

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

const ref = {
  repoFullName: 'ivan/repo',
  headBranch: 'lemniscate/t-1',
  baseBranch: 'main',
};
const pullsUrl = 'https://api.github.com/repos/ivan/repo/pulls';
const ghPull = {
  number: 7,
  html_url: 'https://github.com/ivan/repo/pull/7',
  base: { ref: 'main' },
};
const githubConnection = {
  provider: 'github' as const,
  baseUrl: null,
  accessTokenEnc: encrypt('tok'),
};

// ---------------------------------------------------------------------------

describe('github closePullRequest', () => {
  it('closes the PR via PATCH /pulls/{n} with state=closed', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.includes('state=open')) return mockResponse(200, [{ ...ghPull, number: 7 }]);
      expect(url).toBe(`${pullsUrl}/7`);
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toEqual({ state: 'closed' });
      return mockResponse(200, { state: 'closed' });
    });
    await closePullRequest(githubConnection, ref);
    const headers = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it('throws when the PR cannot be found', async () => {
    stubFetch(() => mockResponse(200, []));
    await expect(closePullRequest(githubConnection, ref)).rejects.toThrow(
      /no open pull request/,
    );
  });
});

describe('github deleteBranch', () => {
  it('deletes the ref via DELETE /git/refs/heads/{branch}', async () => {
    stubFetch((url, init) => {
      expect(url).toBe(
        `https://api.github.com/repos/ivan/repo/git/refs/heads/${encodeURIComponent(ref.headBranch)}`,
      );
      expect(init?.method).toBe('DELETE');
      return mockResponse(204, '');
    });
    await deleteBranch(githubConnection, ref.repoFullName, ref.headBranch);
  });

  it('rethrows provider errors (e.g. branch protected)', async () => {
    stubFetch(() => mockResponse(403, { message: 'branch is protected' }));
    const error = await deleteBranch(
      githubConnection,
      ref.repoFullName,
      ref.headBranch,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

const gitlabConnection = {
  provider: 'gitlab' as const,
  baseUrl: null,
  accessTokenEnc: encrypt('tok'),
  tokenType: 'pat' as const,
};
const gitlabMrsUrl = 'https://gitlab.com/api/v4/projects/ivan%2Frepo/merge_requests';
const glMr = { iid: 11, web_url: 'https://gitlab.com/ivan/repo/-/merge_requests/11' };

describe('gitlab closePullRequest', () => {
  it('closes the MR via PUT /merge_requests/{iid} with state_event=close', async () => {
    stubFetch((url, init) => {
      if (url.includes('state=opened')) return mockResponse(200, [glMr]);
      expect(url).toBe(`${gitlabMrsUrl}/11`);
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({ state_event: 'close' });
      return mockResponse(200, { state: 'closed' });
    });
    await closePullRequest(gitlabConnection, ref);
  });
});

describe('gitlab deleteBranch', () => {
  it('deletes the branch via DELETE /repository/branches/{branch}', async () => {
    stubFetch((url, init) => {
      expect(url).toBe(
        `${gitlabMrsUrl.replace('/merge_requests', '')}/repository/branches/${encodeURIComponent(ref.headBranch)}`,
      );
      expect(init?.method).toBe('DELETE');
      return mockResponse(204, '');
    });
    await deleteBranch(gitlabConnection, ref.repoFullName, ref.headBranch);
  });
});

// ---------------------------------------------------------------------------
// GitVerse (GitHub-shaped)
// ---------------------------------------------------------------------------

const gitverseConnection = {
  provider: 'gitverse' as const,
  baseUrl: null,
  accessTokenEnc: encrypt('tok'),
};
const gvPullsUrl = 'https://api.gitverse.ru/repos/ivan/repo/pulls';
const gvPull = {
  number: 5,
  html_url: 'https://gitverse.ru/ivan/repo/pulls/5',
  head: { ref: ref.headBranch },
  base: { ref: ref.baseBranch },
};

describe('gitverse closePullRequest', () => {
  it('closes the PR via PATCH /pulls/{n} with state=closed', async () => {
    stubFetch((url, init) => {
      if (url.includes('state=open')) return mockResponse(200, [gvPull]);
      expect(url).toBe(`${gvPullsUrl}/5`);
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toEqual({ state: 'closed' });
      return mockResponse(200, { state: 'closed' });
    });
    await closePullRequest(gitverseConnection, ref);
  });
});

describe('gitverse deleteBranch', () => {
  it('deletes the ref via DELETE /git/refs/heads/{branch}', async () => {
    stubFetch((url, init) => {
      expect(init?.method).toBe('DELETE');
      expect(url).toContain('/git/refs/heads/');
      return mockResponse(204, '');
    });
    await deleteBranch(gitverseConnection, ref.repoFullName, ref.headBranch);
  });
});

// ---------------------------------------------------------------------------
// Gitee (GitHub-shaped)
// ---------------------------------------------------------------------------

const giteeConnection = {
  provider: 'gitee' as const,
  baseUrl: null,
  accessTokenEnc: encrypt('tok'),
};
const giteePullsUrl = 'https://gitee.com/api/v5/repos/ivan/repo/pulls';
const giteePull = {
  number: 3,
  html_url: 'https://gitee.com/ivan/repo/pulls/3',
  head: { ref: ref.headBranch },
  base: { ref: ref.baseBranch },
};

describe('gitee closePullRequest', () => {
  it('closes the PR via PATCH /pulls/{n} with state=closed', async () => {
    stubFetch((url, init) => {
      if (url.includes('state=open')) return mockResponse(200, [giteePull]);
      expect(url).toBe(`${giteePullsUrl}/3`);
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toEqual({ state: 'closed' });
      return mockResponse(200, { state: 'closed' });
    });
    await closePullRequest(giteeConnection, ref);
  });
});

describe('gitee deleteBranch', () => {
  it('deletes the branch via DELETE /branches/{branch}', async () => {
    stubFetch((url, init) => {
      expect(init?.method).toBe('DELETE');
      expect(url).toContain('/branches/');
      return mockResponse(204, '');
    });
    await deleteBranch(giteeConnection, ref.repoFullName, ref.headBranch);
  });
});
