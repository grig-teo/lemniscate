// Platform-agnostic types for the @lemniscate/core agent loop.
// No Node/platform imports — this module is the shared vocabulary between
// the standalone package and the backend's streaming/persistence adapters.

export type StepStatus = 'running' | 'done' | 'error' | 'awaiting_approval';

/** Render hint for the timeline; anything non-'tool' renders as a card. */
export type StepKind = 'assistant' | 'tool' | 'plan' | 'skill' | 'steer' | 'subagent';

export interface CoreStep {
  stepId: string;
  status: StepStatus;
  kind: StepKind;
  tool?: string;
  title: string;
  detail?: string;
  outputPreview?: string;
  durationMs?: number;
  tokensUsed?: number;
  /** Depth-1 child loop this step groups (nested steps carry parentStepId). */
  childRunId?: string;
  /** Set on events that belong to a subagent group (child steps). */
  parentStepId?: string;
  /** Present on the final (done/error) subagent group step update. */
  childResult?: SubagentResult;
}

export interface CoreToolResult {
  tool: string;
  title: string;
  detail?: string;
  outputPreview: string;
  durationMs: number;
  error?: string;
}

export interface CoreToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string as emitted by the model. */
  arguments: string;
}

export interface CoreToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CoreChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: CoreToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface CoreUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CoreChatResponse {
  content: string;
  toolCalls: CoreToolCall[];
  hasToolCalls: boolean;
  usage?: CoreUsage;
}

export interface CoreChatRequest {
  messages: CoreChatMessage[];
  tools?: CoreToolSpec[];
  maxTokens: number;
  temperature: number;
  onRetry?: (info: { attempt: number; delayMs: number }) => void;
}

/** Model wiring, platform-agnostic (values already resolved by the host). */
export interface CoreModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiPattern?: string | null;
  maxTokens?: number | null;
  temperature?: number | null;
  /** Used for transcript-compaction thresholding; 0 disables compaction. */
  contextWindow?: number;
  /** Whole-run token budget; null = uncapped. */
  maxTokensPerRun?: number | null;
}

export interface CoreUsageTotals {
  usedTokens: number;
  usedPromptTokens: number;
  usedCompletionTokens: number;
}

export interface SubagentResult {
  summary: string;
  turns: number;
  usage: CoreUsageTotals;
}
