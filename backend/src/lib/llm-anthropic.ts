// Anthropic Messages-API client — the second provider integration pattern
// (see llm-providers.ts). POST <baseUrl>/v1/messages with x-api-key +
// anthropic-version headers; `max_tokens` is required by the API.
//
// Deliberately mirrors llm-client.ts (the OpenAI pattern): same result
// shape (ChatCompletionsResult), same retry policy (429/5xx + network with
// doubling timeouts), same key-scrubbing rule.
//
// Security: the apiKey is used only for the x-api-key header. It is never
// logged, never included in thrown errors (upstream bodies are scrubbed).

import {
  backoffMs,
  LlmError,
  timeoutForAttemptSeconds,
  type ChatCompletionsResult,
  type ChatMessage,
  type ChatUsage,
  type ChatCompletionTool,
  type LlmRetryInfo,
  type ThinkingLevel,
} from './llm-client.js';
import { toAnthropicRequest, toAnthropicTools } from './llm-anthropic-messages.js';
import { errorMessage, redactSecrets, sleep } from './utils.js';

export { toAnthropicRequest } from './llm-anthropic-messages.js';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_RETRIES = 3;
const ERROR_BODY_MAX_CHARS = 500;

export interface AnthropicMessagesParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  /** Required by the Messages API. */
  maxTokens: number;
  temperature?: number;
  timeoutSeconds?: number;
  maxRetries?: number;
  customHeaders?: Record<string, string>;
  onRetry?: (info: LlmRetryInfo) => void;
  onResponseHeaders?: (headers: Headers) => void;
  allowTruncated?: boolean;
  thinkingLevel?: ThinkingLevel;
  tools?: ChatCompletionTool[];
}

interface MessagesResponseBody {
  content?: {
    type?: string;
    text?: string;
    name?: string;
    id?: string;
    input?: Record<string, unknown>;
  }[];
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function extractUsage(usage: MessagesResponseBody['usage']): ChatUsage | undefined {
  if (typeof usage?.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') {
    return undefined;
  }
  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}

function toResult(
  parsed: MessagesResponseBody,
  params: AnthropicMessagesParams,
  startedAt: number,
): ChatCompletionsResult {
  const truncated = parsed.stop_reason === 'max_tokens';
  if (truncated && !params.allowTruncated) {
    throw new LlmError(
      'protocol',
      `LLM response truncated at maxTokens=${params.maxTokens} — raise maxTokens in the LLM config`,
    );
  }
  const textParts: string[] = [];
  const toolCalls: NonNullable<ChatCompletionsResult['toolCalls']> = [];

  for (const block of parsed.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? `tool_${toolCalls.length + 1}`,
        type: 'function',
        function: {
          name: block.name ?? '',
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const text = textParts.join('\n');
  if (!text && toolCalls.length === 0) {
    throw new LlmError('protocol', 'Anthropic response is missing a text content block');
  }
  const usage = extractUsage(parsed.usage);
  return {
    content: text,
    model: parsed.model ?? params.model,
    ...(toolCalls.length > 0 ? { toolCalls, hasToolCalls: true } : {}),
    ...(usage ? { usage } : {}),
    latencyMs: Date.now() - startedAt,
    ...(truncated ? { truncated: true } : {}),
  };
}

function buildBody(params: AnthropicMessagesParams): Record<string, unknown> {
  return {
    model: params.model,
    ...toAnthropicRequest(params.messages),
    max_tokens: params.maxTokens,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.tools && params.tools.length > 0
      ? { tools: toAnthropicTools(params.tools) }
      : {}),
  };
}

function buildHeaders(params: AnthropicMessagesParams): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': params.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    ...params.customHeaders,
  };
}

export function anthropicMessagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

async function attemptFetch(
  params: AnthropicMessagesParams,
  attempt: number,
): Promise<{ response?: Response; timedOut?: boolean; error?: unknown }> {
  const controller = new AbortController();
  const base = params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const timer = setTimeout(() => controller.abort(), timeoutForAttemptSeconds(base, attempt) * 1000);
  try {
    const response = await fetch(anthropicMessagesUrl(params.baseUrl), {
      method: 'POST',
      headers: buildHeaders(params),
      body: JSON.stringify(buildBody(params)),
      signal: controller.signal,
    });
    return { response };
  } catch (err) {
    return { timedOut: controller.signal.aborted, error: err };
  } finally {
    clearTimeout(timer);
  }
}

function networkFailure(
  params: AnthropicMessagesParams,
  outcome: { timedOut?: boolean; error?: unknown },
): LlmError {
  if (outcome.timedOut) return new LlmError('timeout', 'Anthropic request timed out');
  const detail = redactSecrets(errorMessage(outcome.error), [params.apiKey]);
  return new LlmError('network', `Network error calling Anthropic endpoint: ${detail}`);
}

async function errorDetail(params: AnthropicMessagesParams, response: Response): Promise<string> {
  const rawBody = await response.text().catch(() => '');
  return redactSecrets(rawBody.slice(0, ERROR_BODY_MAX_CHARS), [params.apiKey]);
}

export async function anthropicMessages(
  params: AnthropicMessagesParams,
): Promise<ChatCompletionsResult> {
  const startedAt = Date.now();
  const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES;
  for (let attempt = 0; ; attempt++) {
    const outcome = await attemptFetch(params, attempt);
    if (!outcome.response) {
      if (attempt < maxRetries) {
        params.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          delayMs: backoffMs(attempt, null),
          reason: outcome.timedOut ? 'timeout' : 'network error',
        });
        await sleep(backoffMs(attempt, null));
        continue;
      }
      throw networkFailure(params, outcome);
    }
    const { response } = outcome;
    params.onResponseHeaders?.(response.headers);
    if (response.ok) {
      let parsed: MessagesResponseBody;
      try {
        parsed = (await response.json()) as MessagesResponseBody;
      } catch {
        throw new LlmError('protocol', 'Anthropic endpoint returned invalid JSON');
      }
      return toResult(parsed, params, startedAt);
    }
    const status = response.status;
    const detail = await errorDetail(params, response);
    if ((status === 429 || status >= 500) && attempt < maxRetries) {
      const delayMs = backoffMs(attempt, response.headers.get('retry-after'));
      params.onRetry?.({
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        delayMs,
        reason: `HTTP ${status}`,
      });
      await sleep(delayMs);
      continue;
    }
    throw new LlmError(
      'http',
      `Anthropic endpoint returned HTTP ${status}${detail ? `: ${detail}` : ''}`,
      status,
    );
  }
}
