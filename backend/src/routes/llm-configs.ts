import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { encrypt } from '../lib/crypto.js';
import { resolveLlmAccessToken } from '../lib/llm-access-token.js';
import { chatCompletion, type DispatchChatParams } from '../lib/llm-dispatch.js';
import { runConnectionTest, type ConnectionTestParams } from '../lib/llm-connection-test.js';
import { LLM_PROVIDER_PRESETS, apiPatternOf } from '../lib/llm-providers.js';
import { quotaHeaderRecorder, readLlmQuota } from '../lib/llm-quota.js';
import { prisma } from '../lib/prisma.js';
import { assertPublicHttpUrl } from '../lib/url-safety.js';
import { errorMessage } from '../lib/utils.js';
import { requireAuth } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';
import type { LlmConfig } from '@prisma/client';

// LLM configuration CRUD + test-connection endpoints.
// Register with prefix `/api/llm-configs` (done in main.ts).
// Auth comes from the shared plugin (src/plugins/auth.ts): JWT in the
// httpOnly cookie `lemniscate_token`, payload { userId }.

// The test endpoints dial arbitrary URLs with the decrypted API key — keep
// the bucket tight.
const TEST_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

// --- Validation schemas (fields per docs/llm-config.md) ---

const httpUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'baseUrl must be an http(s) URL',
  });

const configFields = {
  name: z.string().min(1).max(100),
  baseUrl: httpUrl,
  model: z.string().min(1).max(200),
  // Transport pattern (llm-providers.ts): 'openai' chat completions or
  // 'anthropic' Messages API. Defaults keep pre-pattern clients working.
  apiPattern: z.enum(['openai', 'anthropic']).default('openai'),
  // Provider preset id the config was added from (null/absent = custom).
  provider: z.string().min(1).max(50).nullish(),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high']).default('off'),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive(),
  contextWindow: z.number().int().positive(),
  systemPromptExtra: z.string().max(4000).optional(),
  timeoutSeconds: z.number().int().min(1).max(600).default(120),
  maxRetries: z.number().int().min(0).max(10).default(3),
  requestsPerMinute: z.number().int().positive(),
  maxTokensPerRun: z.number().int().positive().optional(),
  // Optional USD prices per million tokens; both are required for the
  // estimated-cost fields (a partial price would produce a wrong number).
  inputPricePerMillion: z.number().min(0).optional(),
  outputPricePerMillion: z.number().min(0).optional(),
  customHeaders: z.record(z.string(), z.string()).default({}),
  isDefault: z.boolean().default(false),
  enabled: z.boolean().default(true),
};

const createSchema = z.object({
  ...configFields,
  apiKey: z.string().min(1),
});

const updateSchema = createSchema.partial();

// Test-connection payload: an unsaved config. Same shape as create.
const testSchema = createSchema;

const idParamSchema = z.object({ id: z.string().min(1) });

// --- Helpers ---

// Never expose encrypted credentials over the API.
function serialize(configRecord: LlmConfig) {
  const {
    apiKeyEnc: _apiKeyEnc,
    refreshTokenEnc: _refreshTokenEnc,
    oauthTokenEndpoint: _oauthTokenEndpoint,
    ...rest
  } = configRecord;
  return {
    ...rest,
    hasApiKey: Boolean(_apiKeyEnc),
    authType: configRecord.authType === 'oauth' ? 'oauth' : 'api_key',
  };
}

async function toClientParams(record: LlmConfig) {
  const pattern = apiPatternOf(record);
  return {
    baseUrl: record.baseUrl,
    apiKey: await resolveLlmAccessToken(record),
    model: record.model,
    apiPattern: pattern,
    temperature: record.temperature,
    maxTokens: record.maxTokens,
    ...(record.thinkingLevel !== 'off'
      ? { thinkingLevel: record.thinkingLevel as 'low' | 'medium' | 'high' }
      : {}),
    timeoutSeconds: record.timeoutSeconds,
    maxRetries: record.maxRetries,
    customHeaders: record.customHeaders as Record<string, string>,
    onResponseHeaders: quotaHeaderRecorder(pattern, record.id),
  };
}

// Clears the isDefault flag on the user's other configs (single home for
// the create/update transaction step).
async function clearOtherDefaults(
  tx: Prisma.TransactionClient,
  userId: string,
  excludeId?: string,
): Promise<void> {
  await tx.llmConfig.updateMany({
    where: { userId, isDefault: true, ...(excludeId ? { id: { not: excludeId } } : {}) },
    data: { isDefault: false },
  });
}

// --- Plugin ---

async function listConfigs(request: FastifyRequest) {
  const configs = await prisma.llmConfig.findMany({
    where: { userId: request.userId },
    orderBy: { name: 'asc' },
  });
  return { configs: configs.map(serialize) };
}

async function createConfig(request: FastifyRequest, reply: FastifyReply) {
  const data = parseOrReply(createSchema, request.body, reply, 'Invalid request body', {
    includeIssues: true,
    request,
  });
  if (data === null) return;
  const { apiKey, ...fields } = data;
  if (!(await assertPublicBaseUrl(fields.baseUrl, reply))) return;
  const created = await prisma.$transaction(async (tx) => {
    if (fields.isDefault) {
      await clearOtherDefaults(tx, request.userId!);
    }
    return tx.llmConfig.create({
      data: { ...fields, userId: request.userId!, apiKeyEnc: encrypt(apiKey) },
    });
  });
  return reply.code(201).send(serialize(created));
}

async function getConfig(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid config id');
  if (params === null) return;
  const record = await prisma.llmConfig.findFirst({
    where: { id: params.id, userId: request.userId },
  });
  if (!record) {
    return reply.code(404).send({ error: 'LLM config not found' });
  }
  return serialize(record);
}

async function updateConfig(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid config id');
  if (params === null) return;
  const existing = await prisma.llmConfig.findFirst({
    where: { id: params.id, userId: request.userId },
  });
  if (!existing) {
    return reply.code(404).send({ error: 'LLM config not found' });
  }
  const data = parseOrReply(updateSchema, request.body, reply, 'Invalid request body', {
    includeIssues: true,
    request,
  });
  if (data === null) return;
  const { apiKey, ...fields } = data;
  if (fields.baseUrl && !(await assertPublicBaseUrl(fields.baseUrl, reply))) return;
  const updated = await prisma.$transaction(async (tx) => {
    if (fields.isDefault) {
      await clearOtherDefaults(tx, request.userId!, params.id);
    }
    return tx.llmConfig.update({
      where: { id: params.id },
      // Omitting apiKey keeps the stored one.
      data: { ...fields, ...(apiKey ? { apiKeyEnc: encrypt(apiKey) } : {}) },
    });
  });
  return serialize(updated);
}

async function deleteConfig(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid config id');
  if (params === null) return;
  const { count } = await prisma.llmConfig.deleteMany({
    where: { id: params.id, userId: request.userId },
  });
  if (count === 0) {
    return reply.code(404).send({ error: 'LLM config not found' });
  }
  return reply.code(204).send();
}

// SSRF guard: the backend (and the agent worker) calls baseUrl with the
// user's API key, so it must be publicly routable. Local-dev escape hatch:
// ALLOW_PRIVATE_URLS=true (see lib/url-safety.ts).
async function assertPublicBaseUrl(rawUrl: string, reply: FastifyReply): Promise<boolean> {
  try {
    await assertPublicHttpUrl(rawUrl);
    return true;
  } catch (err) {
    await reply.code(400).send({ error: `baseUrl rejected: ${errorMessage(err)}` });
    return false;
  }
}

// Test an unsaved config payload (test-before-save from the form).
async function testUnsavedConfig(request: FastifyRequest, reply: FastifyReply) {
  const data = parseOrReply(testSchema, request.body, reply, 'Invalid request body', {
    includeIssues: true,
    request,
  });
  if (data === null) return;
  if (!(await assertPublicBaseUrl(data.baseUrl, reply))) return;
  const { apiKey, thinkingLevel, customHeaders, ...fields } = data;
  return runConnectionTest({
    ...fields,
    apiKey,
    ...(thinkingLevel !== 'off' ? { thinkingLevel } : {}),
    customHeaders,
  });
}

// Test a saved config (key decrypted server-side only). The stored baseUrl
// is re-validated: rows saved before the SSRF guard must not dial private
// addresses either.
async function testSavedConfig(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid config id');
  if (params === null) return;
  const record = await prisma.llmConfig.findFirst({
    where: { id: params.id, userId: request.userId },
  });
  if (!record) {
    return reply.code(404).send({ error: 'LLM config not found' });
  }
  if (!(await assertPublicBaseUrl(record.baseUrl, reply))) return;
  return runConnectionTest(await toClientParams(record));
}

// The provider preset registry (OpenAI, Anthropic, z.ai, Kimi, Grok) for
// the settings "Add provider" flows — single source: lib/llm-providers.ts.
async function listProviderPresets() {
  return { presets: LLM_PROVIDER_PRESETS };
}

// Latest rate-limit snapshot captured from this config's response headers
// (llm-quota.ts). Null when the provider exposes nothing (or nothing was
// recorded yet) — the console footer renders "n/a" and never blocks.
async function getConfigQuota(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(idParamSchema, request.params, reply, 'Invalid config id');
  if (params === null) return;
  const record = await prisma.llmConfig.findFirst({
    where: { id: params.id, userId: request.userId },
    select: { id: true },
  });
  if (!record) {
    return reply.code(404).send({ error: 'LLM config not found' });
  }
  return { quota: await readLlmQuota(record.id) };
}

export default async function llmConfigRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.get('/', listConfigs);
  app.post('/', createConfig);
  app.get('/presets', listProviderPresets);
  app.get('/:id', getConfig);
  app.patch('/:id', updateConfig);
  app.delete('/:id', deleteConfig);
  app.get('/:id/quota', getConfigQuota);
  app.post('/test', { config: { rateLimit: TEST_RATE_LIMIT } }, testUnsavedConfig);
  app.post('/:id/test', { config: { rateLimit: TEST_RATE_LIMIT } }, testSavedConfig);
}
