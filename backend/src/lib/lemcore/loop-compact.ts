import type { LemcoreMessage } from './loop-types.js';

/** Fraction of contextWindow at which the transcript is compacted. */
export const COMPACT_THRESHOLD = 0.8;
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
  if (contextWindow == null || contextWindow <= 0) return false;
  return estimateMessageTokens(messages) >= contextWindow * COMPACT_THRESHOLD;
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

  const older = rest.slice(0, rest.length - keepRecent).map(compactOne);
  const recent = rest.slice(rest.length - keepRecent);
  return [...system, ...older, ...recent];
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
