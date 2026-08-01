import { describe, expect, it } from 'vitest';

import { GIT_HTTP_AUTH_USERNAME, gitHttpAuthUsername } from '../src/lib/git-providers/clone-url.js';

// Locks the per-provider git HTTP auth username: 'oauth2' for the external
// hosts (GitHub/GitLab/GitVerse/Gitee accept any username with a valid token),
// but the gitlem account username for the internal host (its git-over-HTTP
// endpoint validates the login against the account's email or username).
describe('gitHttpAuthUsername', () => {
  it('returns oauth2 for external providers', () => {
    expect(gitHttpAuthUsername('github', 'me')).toBe(GIT_HTTP_AUTH_USERNAME);
    expect(gitHttpAuthUsername('gitlab', 'me')).toBe(GIT_HTTP_AUTH_USERNAME);
    expect(gitHttpAuthUsername('gitverse', 'me')).toBe(GIT_HTTP_AUTH_USERNAME);
    expect(gitHttpAuthUsername('gitee', 'me')).toBe(GIT_HTTP_AUTH_USERNAME);
  });

  it('returns the connection username for gitlem', () => {
    expect(gitHttpAuthUsername('gitlem', 'grigori-fiodorov')).toBe('grigori-fiodorov');
  });

  it('is case-insensitive on the provider name', () => {
    expect(gitHttpAuthUsername('Gitlem', 'ann')).toBe('ann');
  });
});
