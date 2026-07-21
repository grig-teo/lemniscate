import { describe, expect, it } from 'vitest';
import { githubAppClientIdError, oauthProviders } from '../src/routes/auth.js';

// Locking test for the GitHub-App-vs-OAuth-App guard: a GitHub App client id
// (Iv…/Iv1…) mints scope-less user tokens that cannot push and see no org
// repos — the login flow requires a classic OAuth App.

describe('oauthProviders', () => {
  it('registers gitee with the documented endpoints and scope', () => {
    const gitee = oauthProviders().gitee;
    expect(gitee.authorizeUrl).toBe('https://gitee.com/oauth/authorize');
    expect(gitee.tokenUrl).toBe('https://gitee.com/oauth/token');
    expect(gitee.scope).toBe('projects user_info');
  });
});

describe('githubAppClientIdError', () => {
  it('flags GitHub App client ids with an actionable message', () => {
    const err = githubAppClientIdError('Iv23liAbCdEf123456');
    expect(err).toMatch(/GitHub App/);
    expect(err).toMatch(/OAuth App/);
    expect(err).toMatch(/Iv23/);
  });

  it('passes classic OAuth App client ids and missing config', () => {
    expect(githubAppClientIdError('Ov23liAbCdEf123456')).toBeNull();
    expect(githubAppClientIdError('0123456789abcdef0123')).toBeNull();
    expect(githubAppClientIdError(undefined)).toBeNull();
  });
});
