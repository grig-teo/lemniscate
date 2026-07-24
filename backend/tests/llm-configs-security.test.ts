import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Locking tests for the LLM-config SSRF guard: baseUrl must be a publicly
// routable http(s) URL on create/update and on both test-connection
// endpoints (the backend calls it with the user's API key).

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  llmFindFirst: vi.fn(),
  llmCreate: vi.fn(),
  llmUpdate: vi.fn(),
  llmUpdateMany: vi.fn(),
  transaction: vi.fn(),
  chatCompletions: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    llmConfig: {
      findFirst: mocks.llmFindFirst,
      create: mocks.llmCreate,
      update: mocks.llmUpdate,
      updateMany: mocks.llmUpdateMany,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock('../src/lib/llm-client.js', () => ({
  chatCompletions: mocks.chatCompletions,
  LlmError: class LlmError extends Error {},
}));

import llmConfigRoutes from '../src/routes/llm-configs.js';
import { signAuthToken } from '../src/plugins/auth.js';

const PUBLIC_URL = 'https://203.0.113.10/v1';
const PRIVATE_URL = 'http://192.168.1.1:11434/v1';

const validBody = {
  name: 'cfg',
  baseUrl: PUBLIC_URL,
  model: 'model',
  maxTokens: 1024,
  contextWindow: 8192,
  requestsPerMinute: 60,
  apiKey: 'sk-test',
};

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(llmConfigRoutes, { prefix: '/api/llm-configs' });
  return app;
}

function injectAuthed(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: 'POST' | 'PATCH',
  url: string,
  payload: unknown,
) {
  return app.inject({
    method,
    url,
    cookies: { lemniscate_token: signAuthToken('user-1', 0) },
    payload,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', sessionVersion: 0 });
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      llmConfig: { updateMany: mocks.llmUpdateMany, create: mocks.llmCreate, update: mocks.llmUpdate },
    }),
  );
});

describe('baseUrl SSRF guard', () => {
  it('rejects a private baseUrl on create with 400', async () => {
    const app = await buildApp();
    const response = await injectAuthed(app, 'POST', '/api/llm-configs/', {
      ...validBody,
      baseUrl: PRIVATE_URL,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/baseUrl/);
    expect(mocks.llmCreate).not.toHaveBeenCalled();
  });

  it('accepts a public https baseUrl on create', async () => {
    mocks.llmCreate.mockImplementation(async ({ data }: { data: object }) => ({
      id: 'cfg-1',
      ...data,
    }));
    const app = await buildApp();
    const response = await injectAuthed(app, 'POST', '/api/llm-configs/', validBody);
    expect(response.statusCode).toBe(201);
    expect(mocks.llmCreate).toHaveBeenCalledOnce();
  });

  it('rejects a private baseUrl on update with 400', async () => {
    mocks.llmFindFirst.mockResolvedValue({ id: 'cfg-1', userId: 'user-1' });
    const app = await buildApp();
    const response = await injectAuthed(app, 'PATCH', '/api/llm-configs/cfg-1', {
      baseUrl: PRIVATE_URL,
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.llmUpdate).not.toHaveBeenCalled();
  });

  it('rejects a private baseUrl on the unsaved test endpoint', async () => {
    const app = await buildApp();
    const response = await injectAuthed(app, 'POST', '/api/llm-configs/test', {
      ...validBody,
      baseUrl: PRIVATE_URL,
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.chatCompletions).not.toHaveBeenCalled();
  });

  it('rejects the saved test endpoint when the stored baseUrl is private', async () => {
    mocks.llmFindFirst.mockResolvedValue({
      id: 'cfg-1',
      userId: 'user-1',
      baseUrl: PRIVATE_URL,
      apiKeyEnc: 'enc',
      model: 'model',
      temperature: 0.2,
      maxTokens: 100,
      thinkingLevel: 'off',
      timeoutSeconds: 120,
      maxRetries: 3,
      customHeaders: {},
    });
    const app = await buildApp();
    const response = await injectAuthed(app, 'POST', '/api/llm-configs/cfg-1/test', {});
    expect(response.statusCode).toBe(400);
    expect(mocks.chatCompletions).not.toHaveBeenCalled();
  });
});
