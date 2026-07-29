import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      del: vi.fn(async (key: string) => {
        store.delete(key);
        return 1;
      }),
    },
    create: vi.fn(),
    updateMany: vi.fn(),
    encrypt: vi.fn((v: string) => `enc:${v}`),
    requestDeviceCode: vi.fn(),
    discoveryUrls: vi.fn(),
    pollDeviceTokenOnce: vi.fn(),
  };
});

vi.mock('../src/lib/redis.js', () => ({
  getRedisClient: () => mocks.redis,
}));

vi.mock('../src/lib/crypto.js', () => ({
  encrypt: mocks.encrypt,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        llmConfig: {
          updateMany: mocks.updateMany,
          create: mocks.create,
        },
      }),
  },
}));

vi.mock('../src/lib/xai-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/xai-oauth.js')>(
    '../src/lib/xai-oauth.js',
  );
  return {
    ...actual,
    requestDeviceCode: mocks.requestDeviceCode,
    discoveryUrls: mocks.discoveryUrls,
    pollDeviceTokenOnce: mocks.pollDeviceTokenOnce,
  };
});

vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: { userId?: string }) => {
    request.userId = 'user-1';
  },
}));

import Fastify from 'fastify';
import xaiOauthRoutes from '../src/routes/xai-oauth.js';

async function build() {
  const app = Fastify();
  await app.register(xaiOauthRoutes, { prefix: '/api/llm-configs/xai-oauth' });
  await app.ready();
  return app;
}

describe('xai-oauth routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    mocks.discoveryUrls.mockResolvedValue({ tokenEndpoint: 'https://auth.x.ai/oauth2/token' });
    mocks.requestDeviceCode.mockResolvedValue({
      deviceCode: 'dev-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://accounts.x.ai/device?user_code=ABCD-EFGH',
      expiresIn: 900,
      interval: 5,
    });
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'cfg-oauth',
      ...data,
      thinkingLevel: 'off',
      temperature: 0.2,
      systemPromptExtra: null,
      timeoutSeconds: 120,
      maxRetries: 3,
      maxTokensPerRun: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      customHeaders: {},
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  });

  it('start returns verification payload and default coding model grok-4.5', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/llm-configs/xai-oauth/start' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sessionId: string;
      userCode: string;
      defaultModel: string;
      models: string[];
    };
    expect(body.userCode).toBe('ABCD-EFGH');
    expect(body.defaultModel).toBe('grok-4.5');
    expect(body.models).toContain('grok-4.5');
    expect(body.sessionId.length).toBeGreaterThan(10);
    expect(mocks.store.size).toBe(1);
    await app.close();
  });

  it('poll → complete creates an oauth LlmConfig with the chosen model', async () => {
    const app = await build();
    const startRes = await app.inject({ method: 'POST', url: '/api/llm-configs/xai-oauth/start' });
    const { sessionId } = startRes.json() as { sessionId: string };

    mocks.pollDeviceTokenOnce.mockResolvedValueOnce({ status: 'pending' });
    const pending = await app.inject({
      method: 'POST',
      url: '/api/llm-configs/xai-oauth/poll',
      payload: { sessionId },
    });
    expect(pending.json()).toEqual({ status: 'pending' });

    mocks.pollDeviceTokenOnce.mockResolvedValueOnce({
      status: 'authorized',
      tokens: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 3600,
        tokenType: 'Bearer',
      },
    });
    const authorized = await app.inject({
      method: 'POST',
      url: '/api/llm-configs/xai-oauth/poll',
      payload: { sessionId },
    });
    expect(authorized.json()).toEqual({ status: 'authorized' });

    const complete = await app.inject({
      method: 'POST',
      url: '/api/llm-configs/xai-oauth/complete',
      payload: { sessionId, model: 'grok-4.5', isDefault: true },
    });
    expect(complete.statusCode).toBe(201);
    const cfg = complete.json() as {
      id: string;
      model: string;
      authType: string;
      provider: string;
      hasApiKey: boolean;
    };
    expect(cfg.model).toBe('grok-4.5');
    expect(cfg.authType).toBe('oauth');
    expect(cfg.provider).toBe('grok');
    expect(cfg.hasApiKey).toBe(true);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authType: 'oauth',
          model: 'grok-4.5',
          apiKeyEnc: 'enc:access-1',
          refreshTokenEnc: 'enc:refresh-1',
          oauthTokenEndpoint: 'https://auth.x.ai/oauth2/token',
        }),
      }),
    );
    // Session consumed.
    expect(mocks.store.size).toBe(0);
    await app.close();
  });
});
