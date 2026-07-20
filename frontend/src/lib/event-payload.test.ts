import { describe, expect, it } from 'vitest';

import {
  diffLineClass,
  firstStringField,
  normalizeDiffEvents,
  payloadPath,
  payloadToLogText,
  statusFromPayload,
  writeAction,
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

describe('payloadPath', () => {
  it('reads path-like fields in priority order', () => {
    expect(payloadPath({ path: 'a.ts', file: 'b.ts' })).toBe('a.ts');
    expect(payloadPath({ filePath: 'c.ts' })).toBe('c.ts');
    expect(payloadPath({ filename: 'd.ts' })).toBe('d.ts');
  });

  it('returns "unknown file" for missing or non-object payloads', () => {
    expect(payloadPath({ path: '' })).toBe('unknown file');
    expect(payloadPath(null)).toBe('unknown file');
    expect(payloadPath('str')).toBe('unknown file');
  });
});

describe('writeAction', () => {
  it('detects creates and deletes from action hints', () => {
    expect(writeAction({ action: 'create' })).toBe('created');
    expect(writeAction({ type: 'added' })).toBe('created');
    expect(writeAction({ operation: 'delete file' })).toBe('deleted');
    expect(writeAction({ change: 'removed' })).toBe('deleted');
  });

  it('defaults to modified', () => {
    expect(writeAction({ action: 'update' })).toBe('modified');
    expect(writeAction({})).toBe('modified');
  });
});

describe('normalizeDiffEvents', () => {
  it('splits raw unified-diff strings into patch lines under "unknown file"', () => {
    const groups = normalizeDiffEvents([{ key: 'k1', payload: '+a\n-b' }]);
    expect(groups).toEqual([{ path: 'unknown file', entries: [{ kind: 'patch', lines: ['+a', '-b'] }] }]);
  });

  it('reads diff/patch text from objects, grouped by path', () => {
    const groups = normalizeDiffEvents([
      { key: 'k1', payload: { path: 'a.ts', diff: '+1' } },
      { key: 'k2', payload: { path: 'a.ts', patch: '+2' } },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toEqual([
      { kind: 'patch', lines: ['+1'] },
      { kind: 'patch', lines: ['+2'] },
    ]);
  });

  it('renders write notifications and unknown payloads as write entries', () => {
    const groups = normalizeDiffEvents([
      { key: 'k1', payload: { path: 'a.ts', action: 'created' } },
      { key: 'k2', payload: null },
    ]);
    expect(groups[0]).toEqual({
      path: 'a.ts',
      entries: [{ kind: 'write', action: 'created' }],
    });
    expect(groups[1]).toEqual({
      path: 'unknown file',
      entries: [{ kind: 'write', action: 'modified' }],
    });
  });

  it('keeps groups in first-seen order', () => {
    const groups = normalizeDiffEvents([
      { key: 'k1', payload: { path: 'b.ts', diff: 'x' } },
      { key: 'k2', payload: { path: 'a.ts', diff: 'y' } },
    ]);
    expect(groups.map((g) => g.path)).toEqual(['b.ts', 'a.ts']);
  });
});

describe('diffLineClass', () => {
  it('colors diff markers', () => {
    expect(diffLineClass('+++ b/a.ts')).toBe('text-zinc-500');
    expect(diffLineClass('--- a/a.ts')).toBe('text-zinc-500');
    expect(diffLineClass('+added')).toBe('bg-green-500/10 text-green-400');
    expect(diffLineClass('-removed')).toBe('bg-red-500/10 text-red-400');
    expect(diffLineClass('@@ -1 +1 @@')).toBe('text-blue-400');
    expect(diffLineClass(' context')).toBe('text-zinc-400');
  });
});
