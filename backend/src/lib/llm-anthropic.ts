// Anthropic Messages-API client — the second provider integration pattern
// (see llm-providers.ts). POST <baseUrl>/v1/messages with x-api-key +
// anthropic-version headers; `max_tokens` is required by the API.
//
// Deliberately mirrors llm-client.ts (the OpenAI pattern): same result
// shape (ChatCompletionsResult), same retry policy (429/5xx + network with
// doubling timeouts), same key-scrubbing rule. thinkingLevel has no
// Anthropic mapping here and is ignored.
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
  type ContentPart,
  type LlmRetryInfo,
  type ThinkingLevel,
} from './llm-client.js';
import { errorMessage, redactSecrets, sleep } from './utils.js';

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
  /** Quota snapshot hook — called with every response's headers. */
  onResponseHeaders?: (headers: Headers) => void;
  /** Connectivity probes: a max_tokens cut-off still proves the config works. */
  allowTruncated?: boolean;
  /** Thinking level (maps to Claude's thinking config). Phase 3. */
  thinkingLevel?: ThinkingLevel;
  /** OpenAI-compatible tool definitions mapped to Anthropic tool_use. Phase 3. */
  tools?: ChatCompletionTool[];
}

// ---------------------------------------------------------------------------
// Message translation (OpenAI shape → Messages API shape)
// ---------------------------------------------------------------------------

type AnthropicContent =
  | string
  | (
      | { type: 'text'; text: string }
      | {
          type: 'image';
          source:
            | { type: 'base64'; media_type: string; data: string }
            | { type: 'url'; url: string };
        }
    )[];

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent;
}

function imagePartToBlock(part: Extract<ContentPart, { type: 'image_url' }>) {
  const url = part.image_url.url;
  const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  if (dataUrl) {
    const [, mediaType = 'image/png', data = ''] = dataUrl;
    return {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: mediaType, data },
    };
  }
  return { type: 'image' as const, source: { type: 'url' as const, url } };
}

function toAnthropicContent(content: ChatMessage['content']): AnthropicContent {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text' ? { type: 'text' as const, text: part.text } : imagePartToBlock(part),
  );
}

/** Split system messages out; Anthropic takes them as a top-level param. */
export function toAnthropicRequest(messages: ChatMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const converted: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      if (typeof message.content === 'string') systemParts.push(message.content);
      continue;
    }
    converted.push({ role: message.role, content: toAnthropicContent(message.content) });
  }
  return {
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages: converted,
  };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface MessagesResponseBody {
  content?: { type?: string; text?: string }[];
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
  const text = (parsed.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  if (!text) {
    throw new LlmError('protocol', 'Anthropic response is missing a text content block');
  }
  const usage = extractUsage(parsed.usage);
  return {
    content: text,
    model: parsed.model ?? params.model,
    ...(usage ? { usage } : {}),
    latencyMs: Date.now() - startedAt,
    ...(truncated ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Request loop (same policy as llm-client.ts)
// ---------------------------------------------------------------------------

function buildBody(params: AnthropicMessagesParams): Record<string, unknown> {
  return {
    model: params.model,
    ...toAnthropicRequest(params.messages),
    max_tokens: params.maxTokens,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
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

// Messages endpoint: the canonical base is https://api.anthropic.com, but
// tolerate configs that already carry a /v1 suffix (avoid /v1/v1/messages).
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

function networkFailure(params: AnthropicMessagesParams, outcome: { timedOut?: boolean; error?: unknown }): LlmError {
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
      await sleep(backoffMs(attempt, response.headers.get('retry-after')));
      continue;
    }
    throw new LlmError(
      'http',
      `Anthropic endpoint returned HTTP ${status}${detail ? `: ${detail}` : ''}`,
      status,
    );
  }
}
