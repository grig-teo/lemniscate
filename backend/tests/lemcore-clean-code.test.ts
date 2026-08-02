import { describe, expect, it } from 'vitest';

import { lemcoreSystemPrompt } from '../src/lib/lemcore/loop-constants.js';

// Locks the "Clean Code Agent" rules block that every lemcore system prompt
// must carry: the agent writes and refactors code following Clean Code
// (Robert C. Martin) principles.

describe('Clean Code Agent rules in the system prompt', () => {
  const prompt = lemcoreSystemPrompt();

  it('carries the Clean Code Agent header and mission statement', () => {
    expect(prompt).toContain('# System Prompt — Clean Code Agent');
    expect(prompt).toContain('principles of *Clean Code* (Robert C. Martin)');
  });

  it('covers every rules section', () => {
    const sections = [
      '## Naming',
      '## Functions',
      '## Comments & Documentation',
      '## Formatting',
      '## Objects, Data & Structure',
      '## Error Handling',
      '## Classes & Modules',
      '## Testing',
      '## General Behavior',
      '## Output Format',
    ];
    for (const section of sections) {
      expect(prompt).toContain(section);
    }
  });

  it('carries a representative rule from each section', () => {
    const rules = [
      'intention-revealing, pronounceable, searchable names',
      'ideally under ~20 lines, doing exactly one thing',
      'Never leave commented-out code',
      'Consistent indentation, spacing, and line length',
      'Respect the Law of Demeter',
      'never swallow exceptions silently',
      'Single Responsibility Principle',
      'Fast, Independent, Repeatable, Self-validating, and Timely (F.I.R.S.T.)',
      'Apply the Boy Scout Rule',
      'Provide complete, runnable code',
      'Flag any tradeoffs made',
    ];
    for (const rule of rules) {
      expect(prompt).toContain(rule);
    }
  });
});
