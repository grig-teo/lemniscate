import { LlmError } from './llm-client.js';
import { chatCompletion, type DispatchChatParams } from './llm-dispatch.js';

// Connection-test plumbing for the llm-configs routes: the probe params and
// the runConnectionTest wrapper shared by the unsaved-payload and saved-config
// test endpoints. Extracted from routes/llm-configs.ts (AGENTS.md §2).

export interface ConnectionTestParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiPattern?: string;
  thinkingLevel?: 'low' | 'medium' | 'high';
  timeoutSeconds?: number;
  maxRetries?: number;
  customHeaders?: Record<string, string>;
}

const TEST_PROMPT = 'Reply with the word ok';
// Reasoning models (e.g. Kimi k3, GLM-5.2 on high thinking) spend tokens on
// reasoning_content first — a tiny budget is exhausted before any visible
// reply. 1024 is still a trivial probe cost, and allowTruncated below makes
// a cut-off reply a pass anyway: any response proves URL/key/model work.
const TEST_MAX_TOKENS = 1024;
const TEST_TIMEOUT_CAP_SECONDS = 30;

function buildTestParams(params: ConnectionTestParams): DispatchChatParams {
  return {
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    model: params.model,
    apiPattern: params.apiPattern ?? 'openai',
    messages: [{ role: 'user', content: TEST_PROMPT }],
    maxTokens: TEST_MAX_TOKENS,
    allowTruncated: true,
    ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
    // Timeout capped at 30s regardless of the configured value.
    timeoutSeconds: Math.min(
      params.timeoutSeconds ?? TEST_TIMEOUT_CAP_SECONDS,
      TEST_TIMEOUT_CAP_SECONDS,
    ),
    maxRetries: params.maxRetries,
    ...(params.customHeaders ? { customHeaders: params.customHeaders } : {}),
  };
}

export async function runConnectionTest(params: ConnectionTestParams) {
  try {
    const result = await chatCompletion(buildTestParams(params));
    return {
      ok: true as const,
      latencyMs: result.latencyMs,
      modelEcho: result.model,
      reply: result.content,
      ...(result.truncated ? { truncated: true } : {}),
    };
  } catch (err) {
    // Errors from llm-client are already scrubbed of the API key.
    const error =
      err instanceof LlmError || err instanceof Error
        ? err.message
        : 'Unknown error';
    return { ok: false as const, error };
  }
}
