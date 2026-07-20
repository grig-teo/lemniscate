import { describe, expect, it } from 'vitest';
import {
  cloneUrlWithToken,
  githubHeaders,
  gitlabApiBase,
  gitlabHeaders,
  gitverseBase,
  gitverseHeaders,
} from '../src/lib/git-providers.js';

// Locking tests for the provider header/base-URL helpers. These were
// duplicated between git-providers.ts and pull-requests.ts; they now have a
// single home in git-providers.ts. Runs with the vitest env (GITVERSE_BASE_URL
// falls back to its default).

describe('cloneUrlWithToken', () => {
  it('embeds the token as oauth2 credentials', () => {
    expect(cloneUrlWithToken('https://github.com/acme/repo.git', 's3cret')).toBe(
      'https://oauth2:s3cret@github.com/acme/repo.git',
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

  it('gitverseHeaders uses the Gitea-style token scheme', () => {
    expect(gitverseHeaders('tok')).toEqual({ Authorization: 'token tok' });
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

  it('gitlabApiBase defaults to gitlab.com and appends /api/v4', () => {
    expect(gitlabApiBase(null)).toBe('https://gitlab.com/api/v4');
    expect(gitlabApiBase('https://gitlab.example.com/')).toBe(
      'https://gitlab.example.com/api/v4',
    );
  });
});
