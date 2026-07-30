import { config } from '../../config.js';
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
  /** Optional skills section injected into the system prompt. */
  skillsSection?: string;
  /**
   * Hard cap on wall-clock time spent waiting for one LLM reply. When a
   * turn's chat call exceeds this (stalled provider, hung stream) the run
   * aborts instead of blocking the worker slot. Default:
   * LEMCORE_STALLED_TURN_TIMEOUT_MINUTES.
   */
  turnTimeoutMs?: number;
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

/** Error thrown when a single LLM turn exceeds the stalled-turn timeout. */
export class LemcoreStalledError extends Error {
  constructor(turn: number, timeoutMs: number) {
    super(
      `lemcore run stalled: no reply from the LLM provider for ` +
        `${Math.round(timeoutMs / 60_000)}m on turn ${turn}; aborting`,
    );
    this.name = 'LemcoreStalledError';
  }
}

/** Per-turn stall cap: the run option wins, else the configured default. */
export function turnTimeoutMs(opts: LemcoreRunOptions): number {
  return opts.turnTimeoutMs ?? config.LEMCORE_STALLED_TURN_TIMEOUT_MINUTES * 60_000;
}

// Promise.race wrapper for one chatCompletion call. A stalled provider
// (hung stream, dead connection that never errors) would otherwise block
// the turn forever; on expiry the run aborts with LemcoreStalledError. The
// losing call still settles in the background — its rejection is swallowed
// here so it never surfaces as an unhandled rejection.
export async function chatWithTurnTimeout<T>(
  turn: number,
  timeoutMs: number,
  call: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const pending = call();
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LemcoreStalledError(turn, timeoutMs)), timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof LemcoreStalledError) pending.catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
