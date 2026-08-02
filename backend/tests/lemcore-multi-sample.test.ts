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

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ChatToolCall } from '../src/lib/llm-client.js';
import type { LlmRuntime } from '../src/lib/agent-runtime.js';
import { extractToolArgs, verifyEditWithFallback } from '../src/lib/lemcore/multi-sample.js';

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

// Regression for the prod EISDIR storm (Aug 2026): verifyEditWithFallback
// re-derived the edit path via parsePathFromArgs(toolCall) — which passed the
// WHOLE tool call object to parseToolCallArguments, so args.path was always
// undefined, relPath collapsed to '' and lintAndMaybeRevert wrote to the
// workdir root: "EISDIR: illegal operation on a directory, open '<workdir>'".
// The relPath now comes from the caller (edit-router), never re-parsed.
describe('verifyEditWithFallback — edit path is honored', () => {
  function tc(name: string, args: Record<string, unknown>): ChatToolCall {
    return {
      id: 'call_1',
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    };
  }
  const fakeRt = { cfg: { contextWindow: 32_000 } } as unknown as LlmRuntime;

  it('writes the edit to the target file — never to the workdir root', async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), 'lemcore-ms-'));
    try {
      await writeFile(path.join(workdir, 'a.txt'), 'hello\n');
      const result = await verifyEditWithFallback({
        workdir,
        rt: fakeRt,
        taskId: 't1',
        toolCall: tc('edit_file', { path: 'a.txt', search: 'hello', replace: 'bye' }),
        relPath: 'a.txt',
        originalContent: 'hello\n',
        primaryNewContent: 'bye\n',
        secrets: [],
      });
      expect(result.error).toBeUndefined();
      expect(result.title).toBe('a.txt');
      expect(await readFile(path.join(workdir, 'a.txt'), 'utf8')).toBe('bye\n');
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
