// Minimal OpenAI-compatible chat completions client (fetch-based).
// Works against OpenAI, Azure-style gateways, vLLM, Ollama, LM Studio, etc.
//
// Security: the apiKey is used only for the Authorization header. It is never
// logged, never included in thrown errors (upstream error bodies are scrubbed
// of it), and never present in the returned result.

import { errorMessage, redactSecrets, sleep } from './utils.js';
import { notifyObserver, type LlmOutcome } from './llm-observer.js';
import { normalizeToolCalls, type ChatCompletionTool } from './llm-tool-calls.js';
import {
  toReasoningEffort,
  type ChatCompletionsParams,
  type ChatCompletionsResult,
  type ChatMessage,
  type ChatUsage,
  type LlmRetryInfo,
  type ThinkingLevel,
} from './llm-types.js';

export { setLlmObserver } from './llm-observer.js';
export type { LlmOutcome, LlmRequestObservation } from './llm-observer.js';
export {
  parseToolCallArguments,
  type ChatCompletionTool,
  type ChatToolCall,
} from './llm-tool-calls.js';
export {
  toReasoningEffort,
  type ChatCompletionsParams,
  type ChatCompletionsResult,
  type ChatMessage,
  type ChatUsage,
  type ContentPart,
  type LlmRetryInfo,
  type ReasoningEffort,
  type ThinkingLevel,
} from './llm-types.js';

export class LlmError extends Error {
  readonly kind: 'http' | 'timeout' | 'network' | 'protocol';
  readonly status?: number;

  constructor(kind: LlmError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const ERROR_BODY_MAX_CHARS = 500;
const MAX_ATTEMPT_TIMEOUT_SECONDS = 600;

// Exported for unit tests. Large-context calls on slow endpoints regularly
// outlast the base timeout; retrying with the same timeout would just fail
// the same way, so every attempt gets twice the room of the previous one.
export function timeoutForAttemptSeconds(baseTimeoutSeconds: number, attempt: number): number {
  return Math.min(baseTimeoutSeconds * 2 ** attempt, MAX_ATTEMPT_TIMEOUT_SECONDS);
}

// `scrubApiKey` keeps the historical call-site name; the implementation
// lives in utils.ts (single home, shared with agent-loop and pull-requests).
const scrubApiKey = (text: string, apiKey: string): string => redactSecrets(text, [apiKey]);

// Exported for unit tests.
export function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, BACKOFF_MAX_MS);
    }
  }
  const exponential = BACKOFF_BASE_MS * 2 ** attempt;
  const jitter = Math.random() * BACKOFF_BASE_MS;
  return Math.min(exponential + jitter, BACKOFF_MAX_MS);
}

interface ChatCompletionsResponseBody {
  choices?: {
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

// Mutable per-call state threaded through the retry loop.
interface RequestState {
  url: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  customHeaders?: Record<string, string>;
  onRetry?: (info: LlmRetryInfo) => void;
  onResponseHeaders?: (headers: Headers) => void;
  timeoutSeconds: number;
  maxRetries: number;
  allowTruncated: boolean;
  startedAt: number;
  /** Flipped off after an HTTP 400 so the retry drops reasoning_effort. */
  includeReasoningEffort: boolean;
  /** Flipped off after an HTTP 400 so the retry drops temperature. */
  includeTemperature: boolean;
  tools?: ChatCompletionTool[];
  seed?: number;
}

function makeRequestState(params: ChatCompletionsParams): RequestState {
  const state: RequestState = {
    url: `${params.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    apiKey: params.apiKey,
    model: params.model,
    messages: params.messages,
    timeoutSeconds: params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    maxRetries: params.maxRetries ?? DEFAULT_MAX_RETRIES,
    allowTruncated: params.allowTruncated ?? false,
    startedAt: Date.now(),
    includeReasoningEffort: params.thinkingLevel !== undefined,
    includeTemperature: params.temperature !== undefined,
    tools: params.tools,
  };
  if (params.temperature !== undefined) state.temperature = params.temperature;
  if (params.maxTokens !== undefined) state.maxTokens = params.maxTokens;
  if (params.thinkingLevel !== undefined) state.thinkingLevel = params.thinkingLevel;
  if (params.customHeaders !== undefined) state.customHeaders = params.customHeaders;
  if (params.onRetry !== undefined) state.onRetry = params.onRetry;
  if (params.onResponseHeaders !== undefined) state.onResponseHeaders = params.onResponseHeaders;
  if (params.seed !== undefined) state.seed = params.seed;
  return state;
}

function buildRequestBody(state: RequestState): Record<string, unknown> {
  const body: Record<string, unknown> = { model: state.model, messages: state.messages };
  if (state.includeTemperature && state.temperature !== undefined) {
    body.temperature = state.temperature;
  }
  if (state.maxTokens !== undefined) body.max_tokens = state.maxTokens;
  if (state.includeReasoningEffort && state.thinkingLevel !== undefined) {
    body.reasoning_effort = toReasoningEffort(state.thinkingLevel);
  }
  if (state.tools !== undefined && state.tools.length > 0) {
    body.tools = state.tools;
  }
  if (state.seed !== undefined) body.seed = state.seed;
  return body;
}

interface FetchOutcome {
  response?: Response;
  timedOut?: boolean;
  error?: unknown;
}

// One POST with an abort-after-timeout; never throws — the caller decides
// whether the failure is retryable.
async function attemptFetch(
  state: RequestState,
  body: unknown,
  attempt: number,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutForAttemptSeconds(state.timeoutSeconds, attempt) * 1000,
  );
  try {
    const response = await fetch(state.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${state.apiKey}`,
        ...state.customHeaders,
      },
      body: JSON.stringify(body),
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
  state: RequestState,
  outcome: FetchOutcome,
  attempt: number,
): LlmError {
  if (outcome.timedOut) {
    return new LlmError(
      'timeout',
      `Request timed out after ${timeoutForAttemptSeconds(state.timeoutSeconds, attempt)}s (attempt ${attempt + 1} of ${state.maxRetries + 1})`,
    );
  }
  const detail = errorMessage(outcome.error);
  return new LlmError(
    'network',
    scrubApiKey(`Network error calling LLM endpoint: ${detail}`, state.apiKey),
  );
}

async function readSuccessJson(response: Response): Promise<ChatCompletionsResponseBody> {
  try {
    return (await response.json()) as ChatCompletionsResponseBody;
  } catch {
    throw new LlmError('protocol', 'LLM endpoint returned invalid JSON');
  }
}

function extractUsage(usage: ChatCompletionsResponseBody['usage']): ChatUsage | undefined {
  if (
    usage &&
    typeof usage.prompt_tokens === 'number' &&
    typeof usage.completion_tokens === 'number' &&
    typeof usage.total_tokens === 'number'
  ) {
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
  }
  return undefined;
}

function toResult(parsed: ChatCompletionsResponseBody, state: RequestState): ChatCompletionsResult {
  const truncated = parsed.choices?.[0]?.finish_reason === 'length';
  if (truncated && !state.allowTruncated) {
    throw new LlmError(
      'protocol',
      `LLM response truncated at maxTokens=${state.maxTokens ?? 'unset'} — raise maxTokens in the LLM config`,
    );
  }
  const message = parsed.choices?.[0]?.message;
  const rawToolCalls = message?.tool_calls ?? parsed.tool_calls;
  const toolCalls = normalizeToolCalls(rawToolCalls);
  const hasToolCalls = toolCalls.length > 0;
  const content = message?.content;
  if (typeof content !== 'string' && !hasToolCalls) {
    throw new LlmError(
      'protocol',
      'LLM endpoint response is missing choices[0].message.content',
    );
  }
  const usage = extractUsage(parsed.usage);
  return {
    content: typeof content === 'string' ? content : '',
    model: parsed.model ?? state.model,
    ...(usage ? { usage } : {}),
    latencyMs: Date.now() - state.startedAt,
    ...(truncated ? { truncated: true } : {}),
    ...(hasToolCalls ? { toolCalls, hasToolCalls: true } : {}),
  };
}

async function errorDetail(state: RequestState, response: Response): Promise<string> {
  const rawBody = await response.text().catch(() => '');
  return scrubApiKey(rawBody.slice(0, ERROR_BODY_MAX_CHARS), state.apiKey);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function networkRetryReason(outcome: FetchOutcome): string {
  return outcome.timedOut ? 'timeout' : 'network error';
}

// Notifies onRetry, then waits out the backoff before the next attempt.
async function backoffAndRetry(
  state: RequestState,
  attempt: number,
  retryAfterHeader: string | null,
  reason: string,
): Promise<void> {
  const delayMs = backoffMs(attempt, retryAfterHeader);
  state.onRetry?.({
    attempt: attempt + 1,
    maxAttempts: state.maxRetries + 1,
    delayMs,
    reason,
  });
  await sleep(delayMs);
}

export async function chatCompletions(
  params: ChatCompletionsParams,
): Promise<ChatCompletionsResult> {
  const state = makeRequestState(params);
  try {
    return await runRequestLoop(state);
  } catch (err) {
    notifyObserver(err instanceof LlmError ? err.kind : 'network', state.startedAt);
    throw err;
  }
}

async function runRequestLoop(state: RequestState): Promise<ChatCompletionsResult> {
  for (let attempt = 0; ; attempt++) {
    const outcome = await attemptFetch(state, buildRequestBody(state), attempt);
    if (!outcome.response) {
      if (attempt < state.maxRetries) {
        await backoffAndRetry(state, attempt, null, networkRetryReason(outcome));
        continue;
      }
      throw networkFailure(state, outcome, attempt);
    }
    const { response } = outcome;
    state.onResponseHeaders?.(response.headers);
    if (response.ok) {
      const result = toResult(await readSuccessJson(response), state);
      notifyObserver('success', state.startedAt);
      return result;
    }
    const status = response.status;
    const detail = await errorDetail(state, response);
    if (status === 400 && state.includeReasoningEffort) {
      state.includeReasoningEffort = false;
      continue;
    }
    // Some models pin a fixed sampling temperature and 400 on any other
    // value; retrying without the field lets the server default apply.
    if (status === 400 && state.includeTemperature) {
      state.includeTemperature = false;
      continue;
    }
    if (isRetryableStatus(status) && attempt < state.maxRetries) {
      await backoffAndRetry(state, attempt, response.headers.get('retry-after'), `HTTP ${status}`);
      continue;
    }
    throw new LlmError(
      'http',
      `LLM endpoint returned HTTP ${status}${detail ? `: ${detail}` : ''}`,
      status,
    );
  }
}
