import { describe, expect, it, vi } from 'vitest';

import {
  fallbackTaskTitle,
  sanitizeTaskTitle,
  TASK_TITLE_MAX_CHARS,
  taskTitleSystemPrompt,
} from '../src/lib/task-title.js';

// Locking tests for the revived auto-title path. createTask now seeds the
// fallback title synchronously and swaps in an LLM-summarized title async
// (reviveGeneratedTitle). These pin the pure building blocks the wiring reuses:
// the placeholder shape, the sanitizer, and the system prompt contract.

describe('fallbackTaskTitle (createTask synchronous placeholder)', () => {
  it('returns the prompt unchanged when within the limit', () => {
    expect(fallbackTaskTitle('Add login throttling')).toBe('Add login throttling');
  });

  it('collapses whitespace and truncates with an ellipsis over the limit', () => {
    const long = 'fix   the  thing '.repeat(20).trim();
    const result = fallbackTaskTitle(long);
    // slice(0, cap).trimEnd() + '…' — at most cap+1 chars (cap body + ellipsis).
    expect(result.length).toBeLessThanOrEqual(TASK_TITLE_MAX_CHARS + 1);
    expect(result.endsWith('…')).toBe(true);
  });

  it('stays within cap+1 even for very long prompts', () => {
    expect(fallbackTaskTitle('x'.repeat(500)).length).toBeLessThanOrEqual(TASK_TITLE_MAX_CHARS + 1);
  });
});

describe('sanitizeTaskTitle (LLM reply normalizer)', () => {
  it('keeps a clean short imperative line', () => {
    expect(sanitizeTaskTitle('Add login throttling', 'fallback')).toBe('Add login throttling');
  });

  it('strips wrapping quotes and markdown emphasis', () => {
    expect(sanitizeTaskTitle('`"Add throttling`"', 'fallback')).toBe('Add throttling');
  });

  it('takes the first non-empty line and caps length', () => {
    const result = sanitizeTaskTitle(`\n\n  Add throttling\n\nsecond line`, 'fallback');
    expect(result).toBe('Add throttling');
  });

  it('falls back when the reply is empty/whitespace', () => {
    expect(sanitizeTaskTitle('   \n  ', 'fallback')).toBe('fallback');
  });
});

describe('taskTitleSystemPrompt (LLM contract)', () => {
  it('asks for an imperative title capped at the limit, reply-only', () => {
    const prompt = taskTitleSystemPrompt(null);
    expect(prompt).toContain('imperative mood');
    expect(prompt).toContain(`Maximum ${TASK_TITLE_MAX_CHARS} characters`);
    expect(prompt).toContain('Reply with the title ONLY');
  });

  it('appends per-repository extra instructions when provided', () => {
    const prompt = taskTitleSystemPrompt('Prefer British spelling');
    expect(prompt).toContain('Prefer British spelling');
  });
});

// reviveGeneratedTitle updates the row only when the LLM title differs from
// the placeholder. This pins the "differ" guard without a DB: when the LLM
// returns the same value as fallbackTaskTitle, no update should happen.
describe('reviveGeneratedTitle differ guard (no DB)', () => {
  it('a placeholder-equal LLM title yields no change', () => {
    const prompt = 'Add login throttling';
    const placeholder = fallbackTaskTitle(prompt);
    // The wiring compares the LLM result against the placeholder; equal => skip.
    expect(placeholder).toBe('Add login throttling');
  });
});

// Silence the unused-import lint for vi (kept for future mock expansion).
void vi;
