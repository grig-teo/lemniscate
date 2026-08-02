import { describe, expect, it } from 'vitest';

import { lemcoreSystemPrompt } from '../src/lib/lemcore/loop-constants.js';

// Locks the lemcore workflow contract: the agent plans first (objective +
// TODO list) and, after each TODO item is marked done, commits and pushes
// that step's file changes to the open PR branch — one commit per mark.

describe('lemcore plan-first workflow', () => {
  const prompt = lemcoreSystemPrompt();

  it('requires a plan (objective + TODO list) before implementation starts', () => {
    expect(prompt).toContain('Before starting implementation');
    expect(prompt).toContain('todo_write');
    expect(prompt).toMatch(/plan/i);
    expect(prompt).toContain('Objective:');
  });

  it('requires one commit per completed TODO item pushed to the open PR branch', () => {
    expect(prompt).toContain('After marking a TODO item done');
    expect(prompt).toContain('git push');
    expect(prompt).toContain('one commit per TODO item');
    expect(prompt).toMatch(/open pull request/i);
  });

  it('only commits when the step actually changed files', () => {
    expect(prompt).toContain('git status --porcelain');
    expect(prompt).toMatch(/skip the commit/i);
  });

  it('never force-pushes or rewrites history', () => {
    expect(prompt).toContain('--force');
  });
});
