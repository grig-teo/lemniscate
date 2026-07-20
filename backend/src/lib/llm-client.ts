// Minimal OpenAI-compatible chat completions client (fetch-based).
// Works against OpenAI, Azure-style gateways, vLLM, Ollama, LM Studio, etc.
//
// Security: the apiKey is used only for the Authorization header. It is never
// logged, never included in thrown errors (upstream error bodies are scrubbed
// of it), and never present in the returned result.

import { errorMessage, redactSecrets, sleep } from './utils.js';

export type ThinkingLevel = 'low' | 'medium' | 'high';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionsParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Maps to `reasoning_effort` when set; transparently dropped on HTTP 400. */
  thinkingLevel?: ThinkingLevel;
  /** Per-attempt timeout. Defaults to 120s. */
  timeoutSeconds?: number;
  /** Retries on 429 / 5xx / network errors. Defaults to 3. */
  maxRetries?: number;
  customHeaders?: Record<string, string>;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionsResult {
  content: string;
  /** Model name echoed by the server (may differ from the requested one). */
  model: string;
  usage?: ChatUsage;
  latencyMs: number;
}

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
  choices?: { message?: { content?: string } }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
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
  timeoutSeconds: number;
  maxRetries: number;
  startedAt: number;
  /** Flipped off after an HTTP 400 so the retry drops reasoning_effort. */
  includeReasoningEffort: boolean;
}

function makeRequestState(params: ChatCompletionsParams): RequestState {
  const state: RequestState = {
    url: `${params.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    apiKey: params.apiKey,
    model: params.model,
    messages: params.messages,
    timeoutSeconds: params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    maxRetries: params.maxRetries ?? DEFAULT_MAX_RETRIES,
    startedAt: Date.now(),
    includeReasoningEffort: params.thinkingLevel !== undefined,
  };
  if (params.temperature !== undefined) state.temperature = params.temperature;
  if (params.maxTokens !== undefined) state.maxTokens = params.maxTokens;
  if (params.thinkingLevel !== undefined) state.thinkingLevel = params.thinkingLevel;
  if (params.customHeaders !== undefined) state.customHeaders = params.customHeaders;
  return state;
}

function buildRequestBody(state: RequestState): Record<string, unknown> {
  const body: Record<string, unknown> = { model: state.model, messages: state.messages };
  if (state.temperature !== undefined) body.temperature = state.temperature;
  if (state.maxTokens !== undefined) body.max_tokens = state.maxTokens;
  if (state.includeReasoningEffort && state.thinkingLevel !== undefined) {
    body.reasoning_effort = state.thinkingLevel;
  }
  return body;
}

interface FetchOutcome {
  response?: Response;
  timedOut?: boolean;
  error?: unknown;
}

// One POST with an abort-after-timeout; never throws — the caller decides
// whether the failure is retryable.
async function attemptFetch(state: RequestState, body: unknown): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), state.timeoutSeconds * 1000);
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

function networkFailure(state: RequestState, outcome: FetchOutcome): LlmError {
  if (outcome.timedOut) {
    return new LlmError(
      'timeout',
      `Request timed out after ${state.timeoutSeconds}s (${state.maxRetries + 1} attempts)`,
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
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LlmError(
      'protocol',
      'LLM endpoint response is missing choices[0].message.content',
    );
  }
  const usage = extractUsage(parsed.usage);
  return {
    content,
    model: parsed.model ?? state.model,
    ...(usage ? { usage } : {}),
    latencyMs: Date.now() - state.startedAt,
  };
}

async function errorDetail(state: RequestState, response: Response): Promise<string> {
  const rawBody = await response.text().catch(() => '');
  return scrubApiKey(rawBody.slice(0, ERROR_BODY_MAX_CHARS), state.apiKey);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function chatCompletions(
  params: ChatCompletionsParams,
): Promise<ChatCompletionsResult> {
  const state = makeRequestState(params);
  for (let attempt = 0; ; attempt++) {
    const outcome = await attemptFetch(state, buildRequestBody(state));
    if (!outcome.response) {
      if (attempt < state.maxRetries) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
      throw networkFailure(state, outcome);
    }
    const { response } = outcome;
    if (response.ok) {
      return toResult(await readSuccessJson(response), state);
    }
    const status = response.status;
    const detail = await errorDetail(state, response);
    if (status === 400 && state.includeReasoningEffort) {
      state.includeReasoningEffort = false;
      continue;
    }
    if (isRetryableStatus(status) && attempt < state.maxRetries) {
      await sleep(backoffMs(attempt, response.headers.get('retry-after')));
      continue;
    }
    throw new LlmError(
      'http',
      `LLM endpoint returned HTTP ${status}${detail ? `: ${detail}` : ''}`,
      status,
    );
  }
}
