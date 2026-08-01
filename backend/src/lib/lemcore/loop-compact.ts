import type { LemcoreMessage } from './loop-types.js';

/** Fraction of contextWindow at which the transcript is compacted. */
export const COMPACT_THRESHOLD = 0.8;
/**
 * Absolute transcript size at which compaction fires regardless of the
 * configured context window. Configs that advertise a huge window (e.g.
 * 1M tokens) would otherwise never compact: the transcript grew past 110k
 * tokens per turn on a real task and burned 11.5M tokens across its runs.
 * 40k keeps per-turn prompt cost bounded while leaving plenty of working
 * context.
 */
export const COMPACT_TOKEN_CAP = 40_000;
/** Number of most recent non-system messages kept verbatim. */
export const COMPACT_KEEP_RECENT = 6;
const COMPACT_PREVIEW_CHARS = 500;

export function estimateMessageTokens(messages: LemcoreMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / 4);
}

export function shouldCompactTranscript(
  messages: LemcoreMessage[],
  contextWindow: number | null | undefined,
): boolean {
  const estimated = estimateMessageTokens(messages);
  if (estimated >= COMPACT_TOKEN_CAP) return true;
  if (contextWindow == null || contextWindow <= 0) return false;
  return estimated >= contextWindow * COMPACT_THRESHOLD;
}

/** Collapse older tool/assistant payloads; keep system + recent turns full. */
export function compactTranscript(
  messages: LemcoreMessage[],
  keepRecent = COMPACT_KEEP_RECENT,
): LemcoreMessage[] {
  if (messages.length === 0) return messages;

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  if (rest.length <= keepRecent) return messages;

  const splitIdx = rest.length - keepRecent;
  let older = rest.slice(0, splitIdx);
  let recent = rest.slice(splitIdx);

  // The raw message-count slice can split an assistant message that carries
  // tool_calls from its matching `tool` result messages. The OpenAI API
  // rejects (HTTP 400) any assistant tool_calls that aren't followed by their
  // tool results. Tool results are always contiguous and follow the assistant
  // that produced them, so if `recent` now starts with a `tool` message, that
  // message (and every leading tool result in `recent`) belongs to the last
  // assistant in `older`. Pull that assistant — plus any of its tool results
  // still sitting in `older` — forward into `recent` so the group stays intact.
  const firstRecent = recent[0];
  if (firstRecent && firstRecent.role === 'tool') {
    const orphanedToolCallId = firstRecent.toolCallId;
    let assistantIdx = -1;
    for (let i = older.length - 1; i >= 0; i--) {
      const m = older[i];
      if (m && m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === orphanedToolCallId)) {
        assistantIdx = i;
        break;
      }
    }
    if (assistantIdx >= 0) {
      const assistant = older[assistantIdx];
      const movedIds = new Set(
        assistant && assistant.role === 'assistant'
          ? (assistant.toolCalls?.map((tc) => tc.id) ?? [])
          : [],
      );
      const moved: LemcoreMessage[] = [];
      const remaining: LemcoreMessage[] = [];
      for (let i = 0; i < older.length; i++) {
        const m = older[i];
        if (!m) continue;
        if (i === assistantIdx) {
          moved.push(m);
        } else if (m.role === 'tool' && movedIds.has(m.toolCallId)) {
          moved.push(m);
        } else {
          remaining.push(m);
        }
      }
      older = remaining;
      recent = [...moved, ...recent];
    }
  }

  const olderCompacted = older.map(compactOne);
  return [...system, ...goalReminders(messages), ...olderCompacted, ...recent];
}

/**
 * Goal-pattern anchor: if the model declared an "Objective:" line in one of its
 * assistant replies (see lemcoreSystemPrompt — "Restate the objective ... in
 * your first reply, prefixed with Objective:"), re-inject the most recent
 * restatement right after the system prompt so compaction never drops the one
 * objective the run tracks to completion. We search ASSISTANT messages rather
 * than the system prompt because the system prompt itself contains the word
 * "Objective:" as part of its instruction example.
 */
function goalReminders(messages: LemcoreMessage[]): LemcoreMessage[] {
  let goal: string | null = null;
  for (const m of messages) {
    if (m.role === 'assistant') {
      const line = latestGoalLine(m.content);
      if (line) goal = line;
    }
  }
  return goal ? [{ role: 'system', content: goal }] : [];
}

function latestGoalLine(content: string): string | null {
  const goals = content
    .split('\n')
    .filter((line) => line.trimStart().toLowerCase().startsWith('objective:'));
  const goal = goals[goals.length - 1]?.trim();
  return goal ? `[goal] ${goal}` : null;
}

function compactOne(m: LemcoreMessage): LemcoreMessage {
  if (m.role === 'tool') {
    const preview = m.content.slice(0, COMPACT_PREVIEW_CHARS);
    const name = m.toolName ?? 'tool';
    const suffix = m.content.length > COMPACT_PREVIEW_CHARS ? '…' : '';
    return {
      role: 'tool',
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      content: `[compacted ${name}] ${preview}${suffix}`,
    };
  }
  if (m.role === 'assistant') {
    const preview = m.content.slice(0, COMPACT_PREVIEW_CHARS);
    const suffix = m.content.length > COMPACT_PREVIEW_CHARS ? '…' : '';
    return {
      role: 'assistant',
      content: preview + suffix,
      // Drop bulky tool_calls args from compacted history; names alone are enough.
      ...(m.toolCalls && m.toolCalls.length > 0
        ? {
            toolCalls: m.toolCalls.map((tc) => ({
              ...tc,
              function: { ...tc.function, arguments: '{}' },
            })),
          }
        : {}),
    };
  }
  if (m.role === 'user' && m.content.length > COMPACT_PREVIEW_CHARS) {
    return { role: 'user', content: m.content.slice(0, COMPACT_PREVIEW_CHARS) + '…' };
  }
  return m;
}
