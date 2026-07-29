import { describe, expect, it } from 'vitest';

import {
  compactTranscript,
  estimateMessageTokens,
  shouldCompactTranscript,
} from '../src/lib/lemcore/loop-compact.js';
import type { LemcoreMessage } from '../src/lib/lemcore/loop-types.js';

function tool(id: string, content: string): LemcoreMessage {
  return { role: 'tool', toolCallId: id, toolName: 'bash', content };
}

describe('estimateMessageTokens / shouldCompactTranscript', () => {
  it('estimates ~chars/4 and trips the 80% threshold', () => {
    const messages: LemcoreMessage[] = [
      { role: 'system', content: 'x'.repeat(400) },
      { role: 'user', content: 'y'.repeat(400) },
    ];
    expect(estimateMessageTokens(messages)).toBe(200);
    expect(shouldCompactTranscript(messages, 300)).toBe(false); // 200 < 240
    expect(shouldCompactTranscript(messages, 250)).toBe(true); // 200 >= 200
    expect(shouldCompactTranscript(messages, 1000)).toBe(false);
    expect(shouldCompactTranscript(messages, null)).toBe(false);
  });
});

describe('compactTranscript', () => {
  it('keeps system + recent messages and shortens older tool outputs', () => {
    const messages: LemcoreMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'a'.repeat(800), toolCalls: undefined },
      tool('1', 'b'.repeat(900)),
      { role: 'assistant', content: 'mid' },
      tool('2', 'recent-tool'),
      { role: 'assistant', content: 'latest' },
    ];
    const out = compactTranscript(messages, 3);
    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
    // older assistant compacted
    const olderAssistant = out.find((m) => m.role === 'assistant' && m.content.startsWith('a'));
    expect(olderAssistant?.content.length).toBeLessThan(800);
    expect(olderAssistant?.content.endsWith('…')).toBe(true);
    // recent three intact
    expect(out.slice(-3)).toEqual([
      { role: 'assistant', content: 'mid' },
      tool('2', 'recent-tool'),
      { role: 'assistant', content: 'latest' },
    ]);
  });

  it('is a no-op when under the keep window', () => {
    const messages: LemcoreMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ];
    expect(compactTranscript(messages, 6)).toEqual(messages);
  });
});
