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
  const system: LemcoreMessage = {
    role: 'system',
    content: `${lemcoreSystemPrompt()}\n\nObjective: fix the login redirect`,
  };
  const filler = (n: number): LemcoreMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: 'tool' as const,
      toolCallId: `t${i}`,
      toolName: 'bash',
      content: 'x'.repeat(900),
    }));

  it('re-injects the declared Objective: line after compacting old turns', () => {
    const out = compactTranscript([system, { role: 'user', content: 'go' }, ...filler(8)], 3);
    const goals = out.filter(
      (m) => m.role === 'system' && m.content === '[goal] Objective: fix the login redirect',
    );
    expect(goals).toHaveLength(1);
    // Reminder sits right after the system prompt, before compacted history.
    expect(out.indexOf(goals[0]!)).toBe(1);
  });

  it('keeps the latest Objective: line when the run restated its goal', () => {
    const restated: LemcoreMessage = {
      role: 'system',
      content: 'Objective: first draft\n…\nObjective: final scope',
    };
    const out = compactTranscript([restated, ...filler(9)], 3);
    const goal = out.find((m) => m.role === 'system' && m.content.startsWith('[goal]'));
    expect(goal?.content).toBe('[goal] Objective: final scope');
  });

  it('adds no reminder when no objective was declared', () => {
    const plain: LemcoreMessage = { role: 'system', content: 'no objective here' };
    const out = compactTranscript([plain, ...filler(9)], 3);
    expect(out.filter((m) => m.role === 'system')).toHaveLength(1);
  });
});
