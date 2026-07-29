import type { ChatToolCall } from '../llm-client.js';

export interface LemcoreStep {
  stepId: string;
  status: 'running' | 'done' | 'error';
  kind: 'assistant' | 'tool';
  tool?: string;
  title: string;
  detail?: string;
  outputPreview?: string;
  durationMs?: number;
  tokensUsed?: number;
}

export interface LemcoreRunOptions {
  taskId: string;
  task: import('../agent-runtime.js').TaskWithRepo;
  workdir: string;
  rt: import('../agent-runtime.js').LlmRuntime;
  prompt: string;
  secrets: string[];
  resumeTranscript?: LemcoreMessage[];
}

/** Persistable transcript entries (JSON-safe). */
export type LemcoreMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ChatToolCall[] }
  | {
      role: 'tool';
      content: string;
      toolCallId: string;
      toolName?: string;
    };
