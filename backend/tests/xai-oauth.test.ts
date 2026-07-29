import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DEVICE_CODE_URL,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_SCOPE,
  XAI_DEFAULT_BASE_URL,
  XAI_DEFAULT_CODING_MODEL,
  buildDeviceCodeRequestBody,
  buildDeviceTokenPollBody,
  buildRefreshTokenBody,
  parseDeviceCodeResponse,
  parseTokenResponse,
  parsePollError,
  accessTokenExpiresAt,
  accessTokenNeedsRefresh,
  discoveryUrls,
} from '../src/lib/xai-oauth.js';

describe('xai-oauth constants', () => {
  it('targets auth.x.ai device-code + SuperGrok/X Premium+ scopes', () => {
    expect(XAI_OAUTH_ISSUER).toBe('https://auth.x.ai');
    expect(XAI_OAUTH_DEVICE_CODE_URL).toBe('https://auth.x.ai/oauth2/device/code');
    expect(XAI_OAUTH_CLIENT_ID).toMatch(/^[0-9a-f-]{36}$/);
    expect(XAI_OAUTH_SCOPE).toContain('offline_access');
    expect(XAI_OAUTH_SCOPE).toContain('api:access');
    expect(XAI_DEFAULT_BASE_URL).toBe('https://api.x.ai/v1');
    expect(XAI_DEFAULT_CODING_MODEL).toBe('grok-4.5');
  });
});

describe('request body builders', () => {
  it('builds the device-code form body', () => {
    expect(buildDeviceCodeRequestBody()).toEqual({
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
    });
  });

  it('builds the device_code token poll body', () => {
    expect(buildDeviceTokenPollBody('dc-1')).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: XAI_OAUTH_CLIENT_ID,
      device_code: 'dc-1',
    });
  });

  it('builds the refresh_token grant body', () => {
    expect(buildRefreshTokenBody('rt-1')).toEqual({
      grant_type: 'refresh_token',
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: 'rt-1',
    });
  });
});

describe('parseDeviceCodeResponse', () => {
  it('extracts the fields the UI needs', () => {
    const parsed = parseDeviceCodeResponse({
      device_code: 'dev',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://accounts.x.ai/device',
      verification_uri_complete: 'https://accounts.x.ai/device?user_code=ABCD-EFGH',
      expires_in: 900,
      interval: 5,
    });
    expect(parsed).toEqual({
      deviceCode: 'dev',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://accounts.x.ai/device?user_code=ABCD-EFGH',
      expiresIn: 900,
      interval: 5,
    });
  });

  it('falls back to verification_uri when complete is missing', () => {
    const parsed = parseDeviceCodeResponse({
      device_code: 'dev',
      user_code: 'CODE',
      verification_uri: 'https://accounts.x.ai/device',
      expires_in: 600,
      interval: 3,
    });
    expect(parsed.verificationUrl).toBe('https://accounts.x.ai/device');
  });

  it('throws when required fields are missing', () => {
    expect(() => parseDeviceCodeResponse({ user_code: 'x' })).toThrow(/device-code/i);
  });
});

describe('parseTokenResponse', () => {
  it('requires access + refresh tokens', () => {
    const tokens = parseTokenResponse({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 3600,
      tokenType: 'Bearer',
    });
  });

  it('throws without access_token', () => {
    expect(() => parseTokenResponse({ refresh_token: 'rt' })).toThrow(/access_token/i);
  });

  it('throws without refresh_token', () => {
    expect(() => parseTokenResponse({ access_token: 'at' })).toThrow(/refresh_token/i);
  });
});

describe('parsePollError', () => {
  it('classifies authorization_pending and slow_down', () => {
    expect(parsePollError({ error: 'authorization_pending' })).toEqual({ kind: 'pending' });
    expect(parsePollError({ error: 'slow_down' })).toEqual({ kind: 'slow_down' });
  });

  it('surfaces other errors with description', () => {
    expect(parsePollError({ error: 'access_denied', error_description: 'nope' })).toEqual({
      kind: 'error',
      message: 'nope',
    });
    expect(parsePollError({ error: 'expired_token' })).toEqual({
      kind: 'error',
      message: 'expired_token',
    });
  });
});

describe('accessTokenExpiresAt / accessTokenNeedsRefresh', () => {
  // JWT payload: { exp: 1_700_000_100 } → base64url
  function jwtWithExp(exp: number): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
    return `${header}.${payload}.sig`;
  }

  it('reads exp from a JWT access token', () => {
    const exp = 1_700_000_100;
    const at = accessTokenExpiresAt(jwtWithExp(exp));
    expect(at?.getTime()).toBe(exp * 1000);
  });

  it('returns null for non-JWT tokens', () => {
    expect(accessTokenExpiresAt('not-a-jwt')).toBeNull();
  });

  it('needs refresh when exp is within the skew window', () => {
    const nowMs = 1_700_000_000_000;
    const soon = Math.floor(nowMs / 1000) + 30; // 30s left
    expect(accessTokenNeedsRefresh(jwtWithExp(soon), 120, new Date(nowMs))).toBe(true);
    const later = Math.floor(nowMs / 1000) + 600; // 10 min left
    expect(accessTokenNeedsRefresh(jwtWithExp(later), 120, new Date(nowMs))).toBe(false);
  });
});

describe('discoveryUrls', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          token_endpoint: 'https://auth.x.ai/oauth2/token',
          authorization_endpoint: 'https://auth.x.ai/oauth2/auth',
        }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads token_endpoint from OIDC discovery', async () => {
    const urls = await discoveryUrls();
    expect(urls.tokenEndpoint).toBe('https://auth.x.ai/oauth2/token');
    expect(fetch).toHaveBeenCalledWith(
      `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`,
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
  });
});
