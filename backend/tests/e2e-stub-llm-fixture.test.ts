import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { llmChangesResponseSchema } from '../src/lib/agent-prompts.js';
import { parseLlmJson } from '../src/lib/llm-json.js';

// Locking test for the e2e stub LLM's canned change-set response
// (tests/e2e/gitstub/llm-fixture.json). The stub must emit exactly the JSON
// shape the agent loop parses; when the contract in agent-prompts.ts or the
// extraction rules in llm-json.ts change, this test forces the fixture to
// move with them instead of silently breaking the e2e suite.

const fixturePath = path.resolve(
  import.meta.dirname,
  '../../tests/e2e/gitstub/llm-fixture.json',
);

describe('e2e stub LLM fixture', () => {
  it('stays parseable by the agent loop change-set contract', () => {
    const raw = readFileSync(fixturePath, 'utf8');
    const parsed = parseLlmJson(llmChangesResponseSchema, raw, 'an invalid change set');
    expect(parsed.summary.length).toBeGreaterThan(0);
    expect(parsed.changes.length).toBeGreaterThan(0);
    for (const change of parsed.changes) {
      if (change.action !== 'delete') {
        expect(typeof change.content).toBe('string');
      }
    }
  });
});
