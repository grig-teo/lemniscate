import { describe, expect, it } from 'vitest';

import {
  firstStringField,
  payloadToDiffText,
  payloadToLogText,
  statusFromPayload,
} from '@/lib/event-payload';

describe('firstStringField', () => {
  it('returns the first present non-empty string among the given keys', () => {
    expect(firstStringField({ a: 1, b: 'two', c: 'three' }, ['a', 'b', 'c'])).toBe('two');
    expect(firstStringField({ a: 'one' }, ['b', 'a'])).toBe('one');
  });

  it('returns null when nothing matches', () => {
    expect(firstStringField({ a: 1 }, ['a', 'b'])).toBeNull();
    expect(firstStringField(null, ['a'])).toBeNull();
    expect(firstStringField('nope', ['a'])).toBeNull();
  });

  it('keeps empty strings unless allowEmpty is false', () => {
    expect(firstStringField({ a: '', b: 'x' }, ['a', 'b'])).toBe('');
    expect(firstStringField({ a: '', b: 'x' }, ['a', 'b'], { allowEmpty: false })).toBe('x');
  });
});

describe('payloadToLogText', () => {
  it('passes strings through', () => {
    expect(payloadToLogText('hello')).toBe('hello');
  });

  it('prefers message, then line, then text', () => {
    expect(payloadToLogText({ message: 'm', line: 'l', text: 't' })).toBe('m');
    expect(payloadToLogText({ line: 'l', text: 't' })).toBe('l');
    expect(payloadToLogText({ text: 't' })).toBe('t');
  });

  it('falls back to JSON for other shapes', () => {
    expect(payloadToLogText({ other: 1 })).toBe(JSON.stringify({ other: 1 }));
    expect(payloadToLogText(42)).toBe('42');
    expect(payloadToLogText(null)).toBe('null');
  });
});

describe('statusFromPayload', () => {
  it('reads string payloads and status fields', () => {
    expect(statusFromPayload('running')).toBe('running');
    expect(statusFromPayload({ status: 'done' })).toBe('done');
  });

  it('returns null otherwise', () => {
    expect(statusFromPayload({ status: 3 })).toBeNull();
    expect(statusFromPayload({ other: 'x' })).toBeNull();
    expect(statusFromPayload(null)).toBeNull();
  });
});

describe('payloadToDiffText', () => {
  it('renders action payloads with their action label', () => {
    expect(payloadToDiffText({ path: 'src/a.ts', action: 'deleted' })).toBe(
      '✎ src/a.ts (deleted)',
    );
    expect(payloadToDiffText({ path: 'src/b.ts', action: 'conflict-resolved' })).toBe(
      '✎ src/b.ts (conflict-resolved)',
    );
  });

  it('labels a diff from /dev/null as created, anything else as modified', () => {
    expect(
      payloadToDiffText({ path: 'src/new.ts', diff: '--- /dev/null\n+++ b/src/new.ts\n+x' }),
    ).toBe('✎ src/new.ts (created)');
    expect(payloadToDiffText({ path: 'src/a.ts', diff: 'diff --git a/src/a.ts b/src/a.ts' })).toBe(
      '✎ src/a.ts (modified)',
    );
  });

  it('returns null when there is no path', () => {
    expect(payloadToDiffText({ diff: 'x' })).toBeNull();
    expect(payloadToDiffText('src/a.ts')).toBeNull();
    expect(payloadToDiffText(null)).toBeNull();
  });
});
