import { afterEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/lib/crypto.js';
import {
  assertRepoPushAccess,
  cloneUrlWithToken,
  fetchProviderProfile,
  getProviderClient,
  githubHeaders,
  gitlabApiBase,
  gitlabHeaders,
  gitverseApiBase,
  gitverseBase,
  gitverseHeaders,
  hasAnyScope,
  normalizeGitverseRepo,
  ProviderError,
} from '../src/lib/git-providers.js';

// Locking tests for the provider header/base-URL helpers. These were
// duplicated between git-providers.ts and pull-requests.ts; they now have a
// single home in git-providers.ts. Runs with the vitest env (GITVERSE_BASE_URL
// falls back to its default).

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubFetch(handler: (url: string) => Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn((input: unknown) => Promise.resolve(handler(String(input))));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('cloneUrlWithToken', () => {
  it('embeds the token as oauth2 credentials', () => {
    expect(cloneUrlWithToken('https://github.com/acme/repo.git', 's3cret')).toBe(
      'https://oauth2:s3cret@github.com/acme/repo.git',
    );
  });

  it('embeds the token for gitverse HTTPS clone URLs', () => {
    expect(cloneUrlWithToken('https://gitverse.ru/acme/repo.git', 's3cret')).toBe(
      'https://oauth2:s3cret@gitverse.ru/acme/repo.git',
    );
  });
});

describe('header builders', () => {
  it('githubHeaders uses Bearer + the GitHub accept header', () => {
    expect(githubHeaders('tok')).toEqual({
      Authorization: 'Bearer tok',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lemniscate',
    });
  });

  it('gitlabHeaders uses PRIVATE-TOKEN for PATs', () => {
    expect(gitlabHeaders('tok', 'pat')).toEqual({ 'PRIVATE-TOKEN': 'tok' });
    expect(gitlabHeaders('tok')).toEqual({ 'PRIVATE-TOKEN': 'tok' });
  });

  it('gitlabHeaders uses Bearer for OAuth tokens', () => {
    expect(gitlabHeaders('tok', 'oauth')).toEqual({ Authorization: 'Bearer tok' });
  });

  it('gitverseHeaders uses Bearer + the vendor accept header', () => {
    expect(gitverseHeaders('tok')).toEqual({
      Authorization: 'Bearer tok',
      Accept: 'application/vnd.gitverse.object+json;version=1',
    });
  });
});

describe('base URL helpers', () => {
  it('gitverseBase defaults to the configured GitVerse URL', () => {
    expect(gitverseBase(null)).toBe('https://gitverse.ru');
    expect(gitverseBase(undefined)).toBe('https://gitverse.ru');
  });

  it('gitverseBase strips trailing slashes', () => {
    expect(gitverseBase('https://gitverse.example.com/')).toBe('https://gitverse.example.com');
  });

  it('gitverseApiBase defaults to api.gitverse.ru', () => {
    expect(gitverseApiBase(null)).toBe('https://api.gitverse.ru');
    expect(gitverseApiBase(undefined)).toBe('https://api.gitverse.ru');
  });

  it('gitverseApiBase maps the web host to its api. subdomain', () => {
    expect(gitverseApiBase('https://gitverse.ru')).toBe('https://api.gitverse.ru');
    expect(gitverseApiBase('https://gitverse.example.com/')).toBe(
      'https://api.gitverse.example.com',
    );
  });

  it('gitlabApiBase defaults to gitlab.com and appends /api/v4', () => {
    expect(gitlabApiBase(null)).toBe('https://gitlab.com/api/v4');
    expect(gitlabApiBase('https://gitlab.example.com/')).toBe(
      'https://gitlab.example.com/api/v4',
    );
  });
});

describe('normalizeGitverseRepo', () => {
  it('maps the GitHub-shaped API payload to the normalized shape', () => {
    expect(
      normalizeGitverseRepo({
        id: 42,
        name: 'repo',
        full_name: 'ivan/repo',
        clone_url: 'https://gitverse.ru/ivan/repo.git',
        default_branch: 'master',
      }),
    ).toEqual({
      externalId: '42',
      name: 'repo',
      fullName: 'ivan/repo',
      cloneUrl: 'https://gitverse.ru/ivan/repo.git',
      defaultBranch: 'master',
    });
  });

  it('falls back to a constructed clone URL and the main branch', () => {
    expect(
      normalizeGitverseRepo({ id: 'abc', name: 'repo', full_name: 'ivan/repo' }),
    ).toEqual({
      externalId: 'abc',
      name: 'repo',
      fullName: 'ivan/repo',
      cloneUrl: 'https://gitverse.ru/ivan/repo.git',
      defaultBranch: 'main',
    });
  });

  it('builds fallback clone URLs from the connection base URL', () => {
    const repo = normalizeGitverseRepo(
      { id: 1, name: 'r', full_name: 'o/r', default_branch: null },
      'https://gitverse.example.com',
    );
    expect(repo.cloneUrl).toBe('https://gitverse.example.com/o/r.git');
    expect(repo.defaultBranch).toBe('main');
  });
});

describe('gitverse API client', () => {
  it('validates the token via GET /user on the api host', async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toBe('https://api.gitverse.ru/user');
      return jsonResponse({ id: 1, login: 'ivan' });
    });
    const profile = await fetchProviderProfile('gitverse', 'tok');
    expect(profile).toEqual({ username: 'ivan' });
    const headers = (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> })
      .headers;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers.Accept).toBe('application/vnd.gitverse.object+json;version=1');
  });

  it('lists repos across per_page/page pagination', async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `repo-${i}`,
      full_name: `ivan/repo-${i}`,
    }));
    stubFetch((url) => {
      const page = new URL(url).searchParams.get('page');
      if (page === '1') return jsonResponse(pageOne);
      if (page === '2') {
        return jsonResponse([
          { id: 100, name: 'last', full_name: 'ivan/last', default_branch: 'dev' },
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    });
    const client = getProviderClient({
      provider: 'gitverse',
      baseUrl: null,
      accessTokenEnc: encrypt('tok'),
    });
    const repos = await client.listRepos();
    expect(repos).toHaveLength(101);
    expect(repos[0]).toMatchObject({
      externalId: '0',
      fullName: 'ivan/repo-0',
      cloneUrl: 'https://gitverse.ru/ivan/repo-0.git',
      defaultBranch: 'main',
    });
    expect(repos[100]).toMatchObject({ externalId: '100', defaultBranch: 'dev' });
  });
});

describe('assertRepoPushAccess', () => {
  it('passes when the GitHub token has push permission on the repo', async () => {
    stubFetch((url) => {
      expect(url).toBe('https://api.github.com/repos/acme/repo');
      return jsonResponse({ full_name: 'acme/repo', permissions: { push: true } });
    });
    await expect(assertRepoPushAccess('github', 'tok', 'acme/repo')).resolves.toBeUndefined();
  });

  it('throws an actionable ProviderError when the GitHub token cannot push', async () => {
    stubFetch(() =>
      jsonResponse({ full_name: 'acme/repo', permissions: { push: false, pull: true } }),
    );
    const err = await assertRepoPushAccess('github', 'tok', 'acme/repo').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('acme/repo');
    expect(err.message).toMatch(/write|push/i);
  });

  it('propagates the provider error when the repo is not visible to the token', async () => {
    stubFetch(() => jsonResponse({ message: 'Not Found' }, 404));
    await expect(assertRepoPushAccess('github', 'tok', 'acme/private')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('passes for GitLab at developer access level and throws below it', async () => {
    stubFetch((url) => {
      expect(url).toBe('https://gitlab.com/api/v4/projects/acme%2Frepo');
      return jsonResponse({ permissions: { project_access: { access_level: 30 } } });
    });
    await expect(assertRepoPushAccess('gitlab', 'tok', 'acme/repo')).resolves.toBeUndefined();

    stubFetch(() =>
      jsonResponse({ permissions: { project_access: { access_level: 20 } } }),
    );
    await expect(assertRepoPushAccess('gitlab', 'tok', 'acme/repo')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('uses group_access for GitLab when project_access is absent', async () => {
    stubFetch(() =>
      jsonResponse({
        permissions: { project_access: null, group_access: { access_level: 50 } },
      }),
    );
    await expect(assertRepoPushAccess('gitlab', 'tok', 'acme/repo')).resolves.toBeUndefined();
  });

  it('throws for GitVerse when permissions say no push, passes when absent', async () => {
    stubFetch((url) => {
      expect(url).toBe('https://api.gitverse.ru/repos/acme/repo');
      return jsonResponse({ full_name: 'acme/repo', permissions: { push: false } });
    });
    await expect(assertRepoPushAccess('gitverse', 'tok', 'acme/repo')).rejects.toBeInstanceOf(
      ProviderError,
    );

    stubFetch(() => jsonResponse({ full_name: 'acme/repo' }));
    await expect(assertRepoPushAccess('gitverse', 'tok', 'acme/repo')).resolves.toBeUndefined();
  });
});

describe('hasAnyScope', () => {
  it('parses comma/space separated scope lists', () => {
    expect(hasAnyScope('repo, read:user, read:org', ['repo'])).toBe(true);
    expect(hasAnyScope('repo read:user', ['read:org'])).toBe(false);
    expect(hasAnyScope('', ['repo'])).toBe(false);
    expect(hasAnyScope(null, ['repo'])).toBe(false);
  });

  it('accepts any of the wanted scopes', () => {
    expect(hasAnyScope('public_repo', ['repo', 'public_repo'])).toBe(true);
    expect(hasAnyScope('read:user', ['repo', 'public_repo'])).toBe(false);
  });
});

describe('assertRepoPushAccess github OAuth scopes', () => {
  it('throws when push permission is present but the repo scope is missing', async () => {
    stubFetch(() =>
      jsonResponse(
        { full_name: 'acme/repo', private: true, permissions: { push: true } },
        200,
        { 'x-oauth-scopes': 'read:user, read:org' },
      ),
    );
    const err = await assertRepoPushAccess('github', 'tok', 'acme/repo').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/repo/);
    expect(err.message).toMatch(/scope/i);
  });

  it('passes with the repo scope on a private repo', async () => {
    stubFetch(() =>
      jsonResponse(
        { full_name: 'acme/repo', private: true, permissions: { push: true } },
        200,
        { 'x-oauth-scopes': 'repo, read:user' },
      ),
    );
    await expect(assertRepoPushAccess('github', 'tok', 'acme/repo')).resolves.toBeUndefined();
  });

  it('accepts public_repo scope for a public repo', async () => {
    stubFetch(() =>
      jsonResponse(
        { full_name: 'acme/repo', private: false, permissions: { push: true } },
        200,
        { 'x-oauth-scopes': 'public_repo' },
      ),
    );
    await expect(assertRepoPushAccess('github', 'tok', 'acme/repo')).resolves.toBeUndefined();
  });

  it('requires the full repo scope for a private repo', async () => {
    stubFetch(() =>
      jsonResponse(
        { full_name: 'acme/repo', private: true, permissions: { push: true } },
        200,
        { 'x-oauth-scopes': 'public_repo' },
      ),
    );
    await expect(assertRepoPushAccess('github', 'tok', 'acme/repo')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('relies on permissions alone when no scope header is sent (fine-grained PAT)', async () => {
    stubFetch(() =>
      jsonResponse({ full_name: 'acme/repo', private: true, permissions: { push: true } }),
    );
    await expect(assertRepoPushAccess('github', 'tok', 'acme/repo')).resolves.toBeUndefined();
  });
});
