import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GOAL_PATTERN,
  lemcoreSystemPrompt,
} from '../src/lib/lemcore/loop-constants.js';
import { compactTranscript } from '../src/lib/lemcore/loop-compact.js';
import type { LemcoreMessage } from '../src/lib/lemcore/loop-types.js';

// Locks the default goal pattern for every lemcore process: track one
// (proposal/prompt description) objective until it is complete.

describe('default goal pattern', () => {
  it('is the single-objective tracking rule', () => {
    expect(DEFAULT_GOAL_PATTERN).toBe(
      'Track one (proposal/prompt description) objective until it is complete.',
    );
  });

  it('is part of every lemcore system prompt', () => {
    const prompt = lemcoreSystemPrompt();
    expect(prompt).toContain(DEFAULT_GOAL_PATTERN);
    expect(prompt).toContain('Objective:');
  });
});

describe('compaction keeps the tracked objective', () => {
  const system: LemcoreMessage = { role: 'system', content: lemcoreSystemPrompt() };
  const filler = (n: number): LemcoreMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: 'tool' as const,
      toolCallId: `t${i}`,
      toolName: 'bash',
      content: 'x'.repeat(900),
    }));

  it('re-injects the Objective: line from the assistant restatement after compacting', () => {
    // The model restates its objective in an assistant message (not the system prompt).
    const restatement: LemcoreMessage = {
      role: 'assistant',
      content: 'Objective: fix the login redirect\n\nI will start by...',
    };
    const out = compactTranscript(
      [system, { role: 'user', content: 'go' }, restatement, ...filler(8)],
      3,
    );
    const goals = out.filter(
      (m) => m.role === 'system' && m.content === '[goal] Objective: fix the login redirect',
    );
    expect(goals).toHaveLength(1);
    expect(out.indexOf(goals[0]!)).toBe(1);
  });

  it('keeps the latest Objective: line from the most recent assistant restatement', () => {
    const first: LemcoreMessage = {
      role: 'assistant', content: 'Objective: first draft\n\nWorking on it...',
    };
    const second: LemcoreMessage = {
      role: 'assistant', content: 'Objective: final scope\n\nNow focused.',
    };
    const out = compactTranscript([system, first, ...filler(4), second, ...filler(5)], 3);
    const goal = out.find((m) => m.role === 'system' && m.content.startsWith('[goal]'));
    expect(goal?.content).toBe('[goal] Objective: final scope');
  });

  it('adds no reminder when no objective was declared', () => {
    const plain: LemcoreMessage = { role: 'system', content: 'no objective here' };
    const out = compactTranscript([plain, ...filler(9)], 3);
    expect(out.filter((m) => m.role === 'system')).toHaveLength(1);
  });
});
