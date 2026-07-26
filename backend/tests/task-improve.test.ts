import { describe, expect, it } from 'vitest';
import {
  IMPROVED_PROMPT_MAX_CHARS,
  improvePromptSystemPrompt,
  improvePromptUserContent,
  sanitizeImprovedPrompt,
} from '../src/lib/task-improve.js';
import { improveBodySchema } from '../src/routes/tasks.js';

// POST /tasks/:id/improve — the console pane's Improve button asks the LLM to
// rewrite a saved-for-later prompt into the structured document shape used
// for generated proposals. Nothing is persisted; the editor applies the
// returned text. These lock the pure helpers (no LLM on dev hosts).

describe('improvePromptSystemPrompt', () => {
  it('demands the same structured sections as generated proposals', () => {
    const prompt = improvePromptSystemPrompt(null);
    expect(prompt).toContain('## 1. Non-Technical Summary');
    expect(prompt).toContain('## 2. Technical Details');
    expect(prompt).toContain('## 3. Success Metrics');
  });

  it('asks for markdown only — no JSON wrapper, no fences', () => {
    const prompt = improvePromptSystemPrompt(null);
    expect(prompt).toContain('ONLY');
    expect(prompt.toLowerCase()).toContain('markdown');
  });

  it('omits the owner block when no extra is set', () => {
    expect(improvePromptSystemPrompt(null)).not.toContain('Additional instructions');
  });

  it('appends the repository owner instructions when set', () => {
    const prompt = improvePromptSystemPrompt('Always mention tests.');
    expect(prompt).toContain('Additional instructions from the repository owner:');
    expect(prompt).toContain('Always mention tests.');
  });
});

describe('improvePromptUserContent', () => {
  it('frames the current title and prompt for the rewrite', () => {
    const content = improvePromptUserContent('Fix login', 'the login form is broken');
    expect(content).toContain('Fix login');
    expect(content).toContain('the login form is broken');
  });

  it('works without a title', () => {
    const content = improvePromptUserContent(undefined, 'add dark mode');
    expect(content).toContain('add dark mode');
  });
});

describe('sanitizeImprovedPrompt', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizeImprovedPrompt('  ## 1. Summary\n\nbody  ', 'fallback')).toBe(
      '## 1. Summary\n\nbody',
    );
  });

  it('strips a single markdown fence wrapping the whole document', () => {
    expect(sanitizeImprovedPrompt('```markdown\n## 1. Summary\n```', 'fallback')).toBe(
      '## 1. Summary',
    );
    expect(sanitizeImprovedPrompt('```\n## 1. Summary\n```', 'fallback')).toBe('## 1. Summary');
  });

  it('falls back to the original prompt on empty or fence-only output', () => {
    expect(sanitizeImprovedPrompt('', 'original')).toBe('original');
    expect(sanitizeImprovedPrompt('   \n  ', 'original')).toBe('original');
    expect(sanitizeImprovedPrompt('```\n\n```', 'original')).toBe('original');
  });

  it('caps the improved prompt at the maximum length', () => {
    const huge = `x${'y'.repeat(IMPROVED_PROMPT_MAX_CHARS + 500)}`;
    expect(sanitizeImprovedPrompt(huge, 'fallback')).toHaveLength(IMPROVED_PROMPT_MAX_CHARS);
  });
});

describe('improveBodySchema', () => {
  it('requires a prompt and accepts an optional title', () => {
    expect(improveBodySchema.parse({ prompt: 'do the thing' })).toEqual({
      prompt: 'do the thing',
    });
    expect(improveBodySchema.parse({ prompt: 'P', title: 'T' })).toEqual({
      prompt: 'P',
      title: 'T',
    });
  });

  it('rejects empty/oversized prompts and unknown keys', () => {
    expect(improveBodySchema.safeParse({}).success).toBe(false);
    expect(improveBodySchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(improveBodySchema.safeParse({ prompt: 'x'.repeat(8001) }).success).toBe(false);
    expect(improveBodySchema.safeParse({ prompt: 'P', status: 'done' }).success).toBe(false);
  });
});
