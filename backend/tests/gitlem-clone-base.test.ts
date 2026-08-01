import { describe, expect, it } from 'vitest';

import { buildGitlemCloneBase } from '../src/lib/gitlem-accounts.js';

// Locks the gitlem clone-base URL builder: it must always produce
// <origin>/api/gitlem/git regardless of whether BACKEND_URL is a bare host
// ("https://host") or includes the API path ("https://host/api"). The
// double-api ("/api/api/gitlem/git") previously broke gitlem clones when the
// deployed BACKEND_URL ended in /api.
describe('buildGitlemCloneBase', () => {
  it('appends /api/gitlem/git to a bare host', () => {
    expect(buildGitlemCloneBase('https://lemniscate.grig-teo.space')).toBe(
      'https://lemniscate.grig-teo.space/api/gitlem/git',
    );
  });

  it('does not double /api when the backend URL already ends in /api', () => {
    expect(buildGitlemCloneBase('https://lemniscate.grig-teo.space/api')).toBe(
      'https://lemniscate.grig-teo.space/api/gitlem/git',
    );
  });

  it('strips a trailing slash before appending', () => {
    expect(buildGitlemCloneBase('https://lemniscate.grig-teo.space/api/')).toBe(
      'https://lemniscate.grig-teo.space/api/gitlem/git',
    );
    expect(buildGitlemCloneBase('http://localhost:3000/')).toBe(
      'http://localhost:3000/api/gitlem/git',
    );
  });

  it('handles a local dev backend URL (no /api)', () => {
    expect(buildGitlemCloneBase('http://localhost:3000')).toBe(
      'http://localhost:3000/api/gitlem/git',
    );
  });
});
