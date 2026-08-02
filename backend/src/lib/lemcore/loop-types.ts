import { config } from '../../config.js';
import type { ChatToolCall } from '../llm-client.js';

export interface LemcoreStep {
  stepId: string;
  // 'awaiting_approval' persists while the loop waits on a user decision
  // (requireToolApproval) and on hydration for approved plan steps.
  status: 'running' | 'done' | 'error' | 'awaiting_approval';
  kind: 'assistant' | 'tool';
  // 'plan' (first-turn step plan), 'skill' (load_skill), 'steer' (mid-run
  // user message), 'todo' (todo_write — surfaced to the ObjectiveTodoPanel),
  // 'objective' (the run's goal line — surfaced to the ObjectiveTodoPanel).
  // Anything non-'tool' renders as a card, not a tool row.
  subtype?: 'plan' | 'skill' | 'steer' | 'todo' | 'objective';
  tool?: string;
  title: string;
  detail?: string;
  outputPreview?: string;
  durationMs?: number;
  tokensUsed?: number;
}

/** 'edit' = implementation rounds; 'planner' = review/fix/verification. */
export type RoundKind = 'edit' | 'planner';

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
  /** Skill objects for progressive disclosure (load_skill tool resolves these). */
  skills?: import('./skills.js').LemcoreSkill[];
  /**
   * Hard cap on wall-clock time spent waiting for one LLM reply. When a
   * turn's chat call exceeds this (stalled provider, hung stream) the run
   * aborts instead of blocking the worker slot. Default:
   * LEMCORE_STALLED_TURN_TIMEOUT_MINUTES.
   */
  turnTimeoutMs?: number;
  /** Round kind for per-step model routing (default 'edit'). */
  roundKind?: RoundKind;
  /**
   * Review-pr runs the impl loop on an existing session workdir: skip the
   * plan gate, tool approvals and self-verification nudges.
   */
  skipSessionGates?: boolean;
  /**
   * Override the default implementation system prompt
   * (lemcoreSystemPrompt). Used by review runs, where the "implement the task
   * completely, including tests" instructions are contradictory — a review
   * should only examine and write a verdict. When unset, lemcoreSystemPrompt()
   * is used.
   */
  systemPromptOverride?: string;
  /**
   * When true, the loop runs a programmatic verify gate (detect + run the
   * project's test/build command) before accepting the model's final reply.
   * On failure the model is nudged with a Reflexion-style critique and the
   * loop continues (up to MAX_GATE_FAILURES). Implementation runs set this
   * true; review runs leave it false (they finish via the review file path).
   */
  verifyGate?: boolean;
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

/**
 * Synthesize placeholder tool results for any assistant tool_calls that lack
 * matching tool messages — happens when the process dies mid-batch between an
 * assistant reply and the tool executor. Without repair the next provider call
 * gets HTTP 400 (tool_calls must be followed by tool results).
 */
export function repairOrphanedToolCalls(messages: LemcoreMessage[]): void {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) answered.add(m.toolCallId);
  }
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.id && !answered.has(tc.id)) {
          messages.push({
            role: 'tool',
            content: 'Tool execution was interrupted (process restart). Re-run the tool if needed.',
            toolCallId: tc.id,
            toolName: 'interrupted',
          });
        }
      }
    }
  }
}

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
