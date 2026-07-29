// Pattern dispatch — the single entry point that routes one chat call to
// the right transport (AGENTS.md §6): OpenAI-compatible chat completions
// (llm-client.ts) or Anthropic Messages (llm-anthropic.ts), selected by the
// config's apiPattern. Every caller (agent runtime, test-connection,
// improve, library preview) goes through here so a config's pattern is
// honored everywhere, not just in the agent loop.

import { anthropicMessages, type AnthropicMessagesParams } from './llm-anthropic.js';
import {
  chatCompletions,
  type ChatCompletionsParams,
  type ChatCompletionsResult,
} from './llm-client.js';
import { parseApiPattern } from './llm-providers.js';

export type DispatchChatParams = ChatCompletionsParams & {
  /** Transport pattern of the calling config; unset/unknown reads as 'openai'. */
  apiPattern?: string | null;
};

// Anthropic requires max_tokens; LlmConfig.maxTokens is mandatory so this
// only backstops hand-built params (tests, probes).
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

// Anthropic only accepts temperature in [0, 1]; the shared LlmConfig schema
// allows 0..2 (valid for OpenAI-compatible endpoints). Clamp here so a value
// stored for the OpenAI pattern can't put Anthropic calls into a permanent
// HTTP 400 state.
function clampAnthropicTemperature(temperature: number): number {
  return Math.min(1, Math.max(0, temperature));
}

function toAnthropicParams(params: DispatchChatParams): AnthropicMessagesParams {
  return {
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    model: params.model,
    messages: params.messages,
    maxTokens: params.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    ...(params.temperature !== undefined
      ? { temperature: clampAnthropicTemperature(params.temperature) }
      : {}),
    ...(params.timeoutSeconds !== undefined ? { timeoutSeconds: params.timeoutSeconds } : {}),
    ...(params.maxRetries !== undefined ? { maxRetries: params.maxRetries } : {}),
    ...(params.customHeaders !== undefined ? { customHeaders: params.customHeaders } : {}),
    ...(params.onResponseHeaders !== undefined
      ? { onResponseHeaders: params.onResponseHeaders }
      : {}),
    ...(params.allowTruncated !== undefined ? { allowTruncated: params.allowTruncated } : {}),
    ...(params.tools !== undefined ? { tools: params.tools } : {}),
    ...(params.onRetry !== undefined ? { onRetry: params.onRetry } : {}),
  };
}

export async function chatCompletion(
  params: DispatchChatParams,
): Promise<ChatCompletionsResult> {
  if (parseApiPattern(params.apiPattern) === 'anthropic') {
    return anthropicMessages(toAnthropicParams(params));
  }
  return chatCompletions(params);
}
