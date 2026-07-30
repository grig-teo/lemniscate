import { MAX_EMPTY_ASSISTANT_REPLIES } from './loop-constants.js';

// Assistant-reply classification for the lemcore loop (extracted to keep
// loop.ts under the 300-line guard — AGENTS.md §5).

export const EMPTY_REPLY_NUDGE =
  'Your previous reply was empty (no content and no tool calls). Continue the task: ' +
  'call the next tool, or — if the implementation is complete — reply with a concise ' +
  'summary of the changes as plain text.';

export type ReplyAction =
  | { kind: 'tools' } // tool calls to execute
  | { kind: 'final' } // non-empty text answer — the run is done
  | { kind: 'nudge'; count: number } // empty reply, still tolerated
  | { kind: 'abort'; count: number }; // empty-reply budget exhausted

// An empty reply is never a legitimate final answer — some providers (e.g.
// z.ai GLM) return finish_reason "stop" with an empty message once the
// reasoning budget is consumed. Whitespace-only content counts as empty.
export function classifyAssistantReply(
  hasToolCalls: boolean,
  content: string,
  consecutiveEmpty: number,
): ReplyAction {
  if (hasToolCalls) return { kind: 'tools' };
  if (content.trim().length > 0) return { kind: 'final' };
  const count = consecutiveEmpty + 1;
  return count >= MAX_EMPTY_ASSISTANT_REPLIES ? { kind: 'abort', count } : { kind: 'nudge', count };
}
