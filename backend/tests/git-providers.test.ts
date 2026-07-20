import { afterEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/lib/crypto.js';
import {
  cloneUrlWithToken,
  fetchProviderProfile,
  getProviderClient,
  githubHeaders,
  gitlabApiBase,
  gitlabHeaders,
  gitverseApiBase,
  gitverseBase,
  gitverseHeaders,
  normalizeGitverseRepo,
} from '../src/lib/git-providers.js';

// Locking tests for the provider header/base-URL helpers. These were
// duplicated between git-providers.ts and pull-requests.ts; they now have a
// single home in git-providers.ts. Runs with the vitest env (GITVERSE_BASE_URL
// falls back to its default).

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
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
