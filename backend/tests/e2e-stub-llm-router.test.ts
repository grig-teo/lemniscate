import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BRANCH_SLUG_REPLY,
  COMMIT_MESSAGE_REPLY,
  completionContent,
  messageText,
  // The router is a plain .mjs fixture module shared with the container
  // image (tests/e2e/gitstub/Dockerfile COPYs it); it has no type
  // declarations, so the import is untyped by design.
  // @ts-expect-error plain .mjs fixture module, no declarations
} from '../../tests/e2e/gitstub/llm-router.mjs';

// Contract test for the e2e mock LLM's scenario router
// (tests/e2e/gitstub/llm-router.mjs). The agent loop's prompts MUST keep
// matching the router's keywords — when agent-prompts.ts rephrases the
// branch-slug or commit-message prompts, this test goes red instead of the
// e2e suite mysteriously timing out in CI.

const fixturePath = path.resolve(
  import.meta.dirname,
  '../../tests/e2e/gitstub/llm-fixture.json',
);
const fixture = readFileSync(fixturePath, 'utf8').trim();

function userMessage(content: unknown) {
  return { role: 'user', content };
}

describe('e2e mock LLM scenario router', () => {
  it('answers the branch-slug prompt with the fixed slug', () => {
    const content = completionContent(
      [userMessage('Suggest a short git branch slug for this task')],
      fixture,
    );
    expect(content).toBe(BRANCH_SLUG_REPLY);
    expect(content).toBe('e2e-smoke');
  });

  it('answers the commit-message prompt with the fixed conventional-commit line', () => {
    const content = completionContent(
      [userMessage('Write a conventional-commit message for these changes')],
      fixture,
    );
    expect(content).toBe(COMMIT_MESSAGE_REPLY);
    expect(content).toMatch(/^feat: /);
  });

  it('answers any other prompt with the canned change-set fixture', () => {
    const content = completionContent([userMessage('Improve this repository')], fixture);
    expect(content).toBe(fixture);
  });

  it('reads multi-part (text blocks) message content too', () => {
    const messages = [
      userMessage([{ type: 'text', text: 'branch slug please' }, { type: 'image', url: 'x' }]),
    ];
    expect(completionContent(messages, fixture)).toBe(BRANCH_SLUG_REPLY);
    expect(messageText(userMessage(42))).toBe('');
  });

  it('falls back to the fixture for empty/missing messages', () => {
    expect(completionContent([], fixture)).toBe(fixture);
    expect(completionContent(undefined, fixture)).toBe(fixture);
  });
});
