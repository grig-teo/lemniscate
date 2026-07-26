import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tests for the optional LLM price fields (inputPricePerMillion /
// outputPricePerMillion, USD per million tokens): accepted on create/update,
// serialized back, and validated (non-negative numbers only).

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  llmFindFirst: vi.fn(),
  llmCreate: vi.fn(),
  llmUpdate: vi.fn(),
  llmUpdateMany: vi.fn(),
  transaction: vi.fn(),
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

import llmConfigRoutes from '../src/routes/llm-configs.js';
import { signAuthToken } from '../src/plugins/auth.js';

const validBody = {
  name: 'cfg',
  baseUrl: 'https://203.0.113.10/v1',
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
  mocks.llmCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: 'cfg-1', ...data }));
  mocks.llmUpdate.mockImplementation(async ({ data }: { data: object }) => ({ id: 'cfg-1', ...data }));
  mocks.llmFindFirst.mockResolvedValue({ id: 'cfg-1', userId: 'user-1' });
});

describe('LLM config price fields', () => {
  it('persists prices on create and serializes them back', async () => {
    const app = await buildApp();
    const response = await injectAuthed(app, 'POST', '/api/llm-configs/', {
      ...validBody,
      inputPricePerMillion: 0.15,
      outputPricePerMillion: 0.6,
    });
    expect(response.statusCode).toBe(201);
    expect(mocks.llmCreate.mock.calls[0]?.[0].data).toMatchObject({
      inputPricePerMillion: 0.15,
      outputPricePerMillion: 0.6,
    });
    expect(response.json()).toMatchObject({
      inputPricePerMillion: 0.15,
      outputPricePerMillion: 0.6,
    });
  });

  it('accepts omitted prices (cost estimation stays off)', async () => {
    const app = await buildApp();
    const response = await injectAuthed(app, 'POST', '/api/llm-configs/', validBody);
    expect(response.statusCode).toBe(201);
    expect(mocks.llmCreate.mock.calls[0]?.[0].data).not.toHaveProperty('inputPricePerMillion');
  });

  it('rejects negative prices', async () => {
    const app = await buildApp();
    const response = await injectAuthed(app, 'POST', '/api/llm-configs/', {
      ...validBody,
      inputPricePerMillion: -1,
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.llmCreate).not.toHaveBeenCalled();
  });

  it('updates prices via PATCH', async () => {
    const app = await buildApp();
    const response = await injectAuthed(app, 'PATCH', '/api/llm-configs/cfg-1', {
      outputPricePerMillion: 2.5,
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.llmUpdate.mock.calls[0]?.[0].data).toMatchObject({ outputPricePerMillion: 2.5 });
  });
});
