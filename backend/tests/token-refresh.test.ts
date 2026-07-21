import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { ProviderError } from '../src/lib/git-providers.js';

// Locking tests for the GitLab OAuth refresh flow (token-refresh.ts):
// expired access tokens are swapped via the refresh_token grant and the
// rotated pair is persisted; legacy rows without tokenExpiresAt recover
// through a single refresh+retry on a 401.

const mocks = vi.hoisted(() => ({
  gitConnectionUpdate: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { gitConnection: { update: mocks.gitConnectionUpdate } },
}));

import {
  buildRefreshRequestBody,
  getValidAccessToken,
  GITLAB_REFRESH_FAILURE_MESSAGE,
  tokenExpiryFromNow,
  tokenIsExpired,
  withGitlabRefreshRetry,
  type StoredTokenConnection,
} from '../src/lib/token-refresh.js';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn((input: unknown, init?: unknown) =>
    Promise.resolve(handler(String(input), init as RequestInit | undefined)),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const FUTURE = new Date(Date.now() + 3600_000);
const PAST = new Date(Date.now() - 60_000);

function gitlabOAuthConnection(overrides: Partial<StoredTokenConnection> = {}): StoredTokenConnection {
  return {
    id: 'conn-1',
    provider: 'gitlab',
    tokenType: 'oauth',
    accessTokenEnc: encrypt('at-old'),
    refreshTokenEnc: encrypt('rt-old'),
    tokenExpiresAt: FUTURE,
    ...overrides,
  };
}

const refreshedResponse = {
  access_token: 'at-new',
  refresh_token: 'rt-new',
  expires_in: 7200,
};

beforeEach(() => {
  mocks.gitConnectionUpdate.mockReset();
  mocks.gitConnectionUpdate.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tokenIsExpired', () => {
  it('treats a missing expiry as not expired (legacy rows decide on 401)', () => {
    expect(tokenIsExpired(null)).toBe(false);
    expect(tokenIsExpired(undefined)).toBe(false);
  });

  it('compares against the current time', () => {
    const now = new Date(1_000_000);
    expect(tokenIsExpired(new Date(999_999), now)).toBe(true);
    expect(tokenIsExpired(new Date(1_000_001), now)).toBe(false);
  });
});

describe('tokenExpiryFromNow', () => {
  it('applies the safety margin so tokens never die mid-call', () => {
    const now = new Date(1_000_000);
    expect(tokenExpiryFromNow(7200, now).getTime()).toBe(1_000_000 + (7200 - 60) * 1000);
  });
});

describe('buildRefreshRequestBody', () => {
  it('builds the refresh_token grant payload', () => {
    const body = JSON.parse(buildRefreshRequestBody('rt-1', 'cid', 'csecret'));
    expect(body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: 'cid',
      client_secret: 'csecret',
    });
  });
});

describe('getValidAccessToken', () => {
  it('returns the stored token when it is not expired', async () => {
    stubFetch(() => {
      throw new Error('fetch must not be called');
    });
    const token = await getValidAccessToken(gitlabOAuthConnection());
    expect(token).toBe('at-old');
    expect(mocks.gitConnectionUpdate).not.toHaveBeenCalled();
  });

  it('returns the stored token for PAT and non-gitlab connections even when expired', async () => {
    stubFetch(() => {
      throw new Error('fetch must not be called');
    });
    await expect(
      getValidAccessToken(gitlabOAuthConnection({ tokenType: 'pat', tokenExpiresAt: PAST })),
    ).resolves.toBe('at-old');
    await expect(
      getValidAccessToken(gitlabOAuthConnection({ provider: 'github', tokenExpiresAt: PAST })),
    ).resolves.toBe('at-old');
  });

  it('does not proactively refresh legacy rows without an expiry', async () => {
    stubFetch(() => {
      throw new Error('fetch must not be called');
    });
    await expect(
      getValidAccessToken(gitlabOAuthConnection({ tokenExpiresAt: null })),
    ).resolves.toBe('at-old');
  });

  it('refreshes an expired token and persists the rotated pair', async () => {
    const fetchMock = stubFetch(() => jsonResponse(refreshedResponse));
    const token = await getValidAccessToken(gitlabOAuthConnection({ tokenExpiresAt: PAST }));
    expect(token).toBe('at-new');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gitlab.com/oauth/token');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('rt-old');

    expect(mocks.gitConnectionUpdate).toHaveBeenCalledTimes(1);
    const update = mocks.gitConnectionUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { accessTokenEnc: string; refreshTokenEnc: string; tokenExpiresAt: Date };
    };
    expect(update.where).toEqual({ id: 'conn-1' });
    expect(decrypt(update.data.accessTokenEnc)).toBe('at-new');
    expect(decrypt(update.data.refreshTokenEnc)).toBe('rt-new');
    // ~2h minus the 60s safety margin from now.
    const expiresInMs = update.data.tokenExpiresAt.getTime() - Date.now();
    expect(expiresInMs).toBeGreaterThan((7200 - 120) * 1000);
    expect(expiresInMs).toBeLessThanOrEqual((7200 - 60) * 1000);
  });

  it('throws an actionable ProviderError when the refresh fails', async () => {
    stubFetch(() => jsonResponse({ error: 'invalid_grant' }, 400));
    const err = await getValidAccessToken(
      gitlabOAuthConnection({ tokenExpiresAt: PAST }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(400);
    expect((err as ProviderError).message).toBe(GITLAB_REFRESH_FAILURE_MESSAGE);
    expect((err as ProviderError).message).toContain('reconnect GitLab in Settings');
    expect(mocks.gitConnectionUpdate).not.toHaveBeenCalled();
  });
});

describe('withGitlabRefreshRetry', () => {
  it('passes the valid token through without refreshing', async () => {
    stubFetch(() => {
      throw new Error('fetch must not be called');
    });
    const seen: string[] = [];
    const result = await withGitlabRefreshRetry(gitlabOAuthConnection(), async (token) => {
      seen.push(token);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual(['at-old']);
  });

  it('refreshes once and retries after a 401 on a legacy row', async () => {
    stubFetch(() => jsonResponse(refreshedResponse));
    const seen: string[] = [];
    const result = await withGitlabRefreshRetry(
      gitlabOAuthConnection({ tokenExpiresAt: null }),
      async (token) => {
        seen.push(token);
        if (seen.length === 1) throw new ProviderError('gitlab: 401 invalid_token', 401);
        return 'recovered';
      },
    );
    expect(result).toBe('recovered');
    expect(seen).toEqual(['at-old', 'at-new']);
    expect(mocks.gitConnectionUpdate).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original 401 when there is no refresh token', async () => {
    stubFetch(() => {
      throw new Error('fetch must not be called');
    });
    const original = new ProviderError('gitlab: 401 invalid_token', 401);
    await expect(
      withGitlabRefreshRetry(gitlabOAuthConnection({ refreshTokenEnc: null }), async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(mocks.gitConnectionUpdate).not.toHaveBeenCalled();
  });

  it('rethrows non-401 errors without refreshing', async () => {
    stubFetch(() => {
      throw new Error('fetch must not be called');
    });
    const original = new ProviderError('gitlab: 500 boom', 500);
    await expect(
      withGitlabRefreshRetry(gitlabOAuthConnection({ tokenExpiresAt: null }), async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it('surfaces the actionable error when the retry refresh fails', async () => {
    stubFetch(() => jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(
      withGitlabRefreshRetry(gitlabOAuthConnection({ tokenExpiresAt: null }), async () => {
        throw new ProviderError('gitlab: 401 invalid_token', 401);
      }),
    ).rejects.toThrow(GITLAB_REFRESH_FAILURE_MESSAGE);
  });
});
