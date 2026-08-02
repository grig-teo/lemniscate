import { describe, expect, it } from 'vitest';

// extractToolArgs is not exported but is the regex that parses the fallback
// LLM's tool-call response. We test it through the public computeEditContent
// path, which depends on a parsed args object. To isolate the parser, we
// re-implement the call shape the fallback produces (a chat completion whose
// `content` is a JSON tool-call string) and assert computeEditContent receives
// the right args.
//
// The bug (C1): the old regex /\{[\s\S]*?"path"[\s\S]*?\}/ stopped at the
// FIRST `}` after "path" — breaking for any payload with a nested `}` (a
// multi_edit edits array, or a write_file/edit_file whose content has braces).

import { extractToolArgs } from '../src/lib/lemcore/multi-sample.js';

describe('extractToolArgs — balanced-brace JSON extraction', () => {
  it('parses a simple edit_file payload', () => {
    const args = extractToolArgs('{"path":"src/a.ts","search":"old","replace":"new"}');
    expect(args).not.toBeNull();
    expect(args!.path).toBe('src/a.ts');
    expect(args!.search).toBe('old');
  });

  it('parses a multi_edit payload with a nested edits array (the C1 bug)', () => {
    const payload = '{"path":"src/a.ts","edits":[{"search":"x","replace":"y"}]}';
    const args = extractToolArgs(payload);
    expect(args).not.toBeNull();
    expect(args!.path).toBe('src/a.ts');
    expect(Array.isArray(args!.edits)).toBe(true);
    expect(args!.edits[0].search).toBe('x');
  });

  it('parses a write_file payload whose content contains braces', () => {
    const payload = '{"path":"src/a.ts","content":"function foo() { return 1; }"}';
    const args = extractToolArgs(payload);
    expect(args).not.toBeNull();
    expect(args!.path).toBe('src/a.ts');
    expect(args!.content).toContain('{ return 1; }');
  });

  it('parses an edit_file where the replace text contains a closing brace', () => {
    const payload = '{"path":"a.ts","search":"x","replace":"if (x) { y }"}';
    const args = extractToolArgs(payload);
    expect(args).not.toBeNull();
    expect(args!.replace).toBe('if (x) { y }');
  });

  it('extracts the JSON from surrounding prose', () => {
    const content = 'I will fix the test.\n\n{"path":"t.ts","search":"a","replace":"b"}\n\nDone.';
    const args = extractToolArgs(content);
    expect(args).not.toBeNull();
    expect(args!.path).toBe('t.ts');
  });

  it('returns null when no JSON object with "path" is present', () => {
    expect(extractToolArgs('no json here')).toBeNull();
    expect(extractToolArgs('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extractToolArgs('{path: missing quotes}')).toBeNull();
  });
});
