import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractJsonArray, extractJsonObject, parseLlmJson } from '../src/lib/llm-json.js';

// Locking tests for the strict-JSON extraction that was duplicated verbatim
// between agent-loop.ts and pr-review.ts, plus the shared safeParse+message
// pattern used by every LLM response parser.

describe('extractJsonObject', () => {
  it('parses a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('tolerates surrounding prose', () => {
    expect(extractJsonObject('pre {"a":1} post')).toEqual({ a: 1 });
  });

  it('throws when no object is present', () => {
    expect(() => extractJsonObject('no json')).toThrow(/did not contain a JSON object/);
  });

  it('throws on malformed JSON', () => {
    expect(() => extractJsonObject('{"a": }')).toThrow(/malformed JSON/);
  });

  it('includes a whitespace-collapsed snippet of the raw response in errors', () => {
    expect(() => extractJsonObject('no\n  json\n\there')).toThrow(/no json here/);
    expect(() => extractJsonObject('{"a":\n  }')).toThrow(/"a": }/);
  });

  it('caps the snippet at 300 characters', () => {
    const raw = 'y'.repeat(400);
    let message = '';
    try {
      extractJsonObject(raw);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('y'.repeat(300));
    expect(message).not.toContain('y'.repeat(301));
  });
});

describe('extractJsonArray', () => {
  it('parses a bare array', () => {
    expect(extractJsonArray('[1,2]')).toEqual([1, 2]);
  });

  it('tolerates surrounding prose', () => {
    expect(extractJsonArray('see: [1] done')).toEqual([1]);
  });

  it('throws when no array is present', () => {
    expect(() => extractJsonArray('{"a":1}')).toThrow(/did not contain a JSON array/);
  });

  it('throws on malformed JSON', () => {
    expect(() => extractJsonArray('[1, ]')).toThrow(/malformed JSON/);
  });
});

describe('parseLlmJson', () => {
  const schema = z.object({ ok: z.boolean() });

  it('returns parsed data on success', () => {
    expect(parseLlmJson(schema, '{"ok":true}', 'an invalid widget')).toEqual({ ok: true });
  });

  it('throws with the caller-provided label and first issue message', () => {
    expect(() => parseLlmJson(schema, '{"ok":"yes"}', 'an invalid widget')).toThrow(
      /^LLM returned an invalid widget: /,
    );
  });

  it('propagates the extraction error when no object is present', () => {
    expect(() => parseLlmJson(schema, '[]', 'an invalid widget')).toThrow(
      /did not contain a JSON object/,
    );
  });
});
