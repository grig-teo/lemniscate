import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { LlmConfig } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  refresh: vi.fn(),
  decrypt: vi.fn((v: string) => `plain:${v}`),
  encrypt: vi.fn((v: string) => `enc:${v}`),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { llmConfig: { update: mocks.update } },
}));

vi.mock('../src/lib/crypto.js', () => ({
  decrypt: mocks.decrypt,
  encrypt: mocks.encrypt,
}));

vi.mock('../src/lib/xai-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/xai-oauth.js')>(
    '../src/lib/xai-oauth.js',
  );
  return {
    ...actual,
    refreshXaiAccessToken: mocks.refresh,
  };
});

import { resolveLlmAccessToken } from '../src/lib/llm-access-token.js';

function jwtWithExp(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function makeConfig(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: 'cfg1',
    userId: 'u1',
    name: 'Grok',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnc: 'enc-access',
    model: 'grok-4.5',
    apiPattern: 'openai',
    provider: 'grok',
    authType: 'api_key',
    refreshTokenEnc: null,
    tokenExpiresAt: null,
    oauthTokenEndpoint: null,
    thinkingLevel: 'off',
    temperature: 0.2,
    maxTokens: 8192,
    contextWindow: 256000,
    systemPromptExtra: null,
    timeoutSeconds: 120,
    maxRetries: 3,
    requestsPerMinute: 60,
    maxTokensPerRun: null,
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    customHeaders: {},
    isDefault: false,
    enabled: true,
    ...over,
  } as LlmConfig;
}

describe('resolveLlmAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decrypt.mockImplementation((v: string) => `plain:${v}`);
    mocks.encrypt.mockImplementation((v: string) => `enc:${v}`);
  });

  it('returns the decrypted API key for api_key configs without refreshing', async () => {
    const token = await resolveLlmAccessToken(makeConfig({ authType: 'api_key' }));
    expect(token).toBe('plain:enc-access');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('returns the access token for oauth configs that are not near expiry', async () => {
    const far = Math.floor(Date.now() / 1000) + 3600;
    mocks.decrypt.mockImplementation((v: string) => {
      if (v === 'enc-access') return jwtWithExp(far);
      return `plain:${v}`;
    });
    const token = await resolveLlmAccessToken(
      makeConfig({
        authType: 'oauth',
        refreshTokenEnc: 'enc-refresh',
        oauthTokenEndpoint: 'https://auth.x.ai/oauth2/token',
      }),
    );
    expect(token).toBe(jwtWithExp(far));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('refreshes and persists rotated tokens when the access token is near expiry', async () => {
    const soon = Math.floor(Date.now() / 1000) + 30;
    const newAccess = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    mocks.decrypt.mockImplementation((v: string) => {
      if (v === 'enc-access') return jwtWithExp(soon);
      if (v === 'enc-refresh') return 'rt-old';
      return `plain:${v}`;
    });
    mocks.refresh.mockResolvedValue({
      accessToken: newAccess,
      refreshToken: 'rt-new',
      expiresIn: 3600,
      tokenType: 'Bearer',
    });
    mocks.update.mockResolvedValue({});

    const token = await resolveLlmAccessToken(
      makeConfig({
        authType: 'oauth',
        refreshTokenEnc: 'enc-refresh',
        oauthTokenEndpoint: 'https://auth.x.ai/oauth2/token',
      }),
    );

    expect(token).toBe(newAccess);
    expect(mocks.refresh).toHaveBeenCalledWith('rt-old', 'https://auth.x.ai/oauth2/token');
    expect(mocks.encrypt).toHaveBeenCalledWith(newAccess);
    expect(mocks.encrypt).toHaveBeenCalledWith('rt-new');
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cfg1' },
        data: expect.objectContaining({
          apiKeyEnc: `enc:${newAccess}`,
          refreshTokenEnc: 'enc:rt-new',
        }),
      }),
    );
  });

  it('throws a reconnect hint when oauth config has no refresh token', async () => {
    await expect(
      resolveLlmAccessToken(makeConfig({ authType: 'oauth', refreshTokenEnc: null })),
    ).rejects.toThrow(/reconnect/i);
  });
});
