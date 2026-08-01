import type { ChatCompletionTool, ChatToolCall } from './llm-tool-calls.js';

export type ThinkingLevel = 'low' | 'medium' | 'high' | 'max';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export function toReasoningEffort(level: ThinkingLevel): ReasoningEffort {
  return level === 'max' ? 'xhigh' : level;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | {
      role: 'assistant';
      content: string | ContentPart[] | null;
      tool_calls?: ChatToolCall[];
    }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface LlmRetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export interface ChatCompletionsParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  timeoutSeconds?: number;
  maxRetries?: number;
  customHeaders?: Record<string, string>;
  onRetry?: (info: LlmRetryInfo) => void;
  onResponseHeaders?: (headers: Headers) => void;
  allowTruncated?: boolean;
  tools?: ChatCompletionTool[];
  /** Seed for deterministic-ish sampling (multi-sample verification). */
  seed?: number;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionsResult {
  content: string;
  model: string;
  usage?: ChatUsage;
  latencyMs: number;
  truncated?: boolean;
  toolCalls?: ChatToolCall[];
  hasToolCalls?: boolean;
}
