import { describe, expect, it } from 'vitest';

import { readStoredJson, writeStoredJson } from '@/lib/persist';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

describe('readStoredJson', () => {
  it('returns the fallback when storage is unavailable', () => {
    expect(readStoredJson(null, 'key', 42)).toBe(42);
  });

  it('returns the fallback when nothing is stored', () => {
    expect(readStoredJson(fakeStorage(), 'key', { a: 1 })).toEqual({ a: 1 });
  });

  it('parses a stored JSON value', () => {
    const storage = fakeStorage({ key: '{"a":1}' });
    expect(readStoredJson(storage, 'key', null)).toEqual({ a: 1 });
  });

  it('returns the fallback on invalid JSON', () => {
    const storage = fakeStorage({ key: '{oops' });
    expect(readStoredJson(storage, 'key', [])).toEqual([]);
  });
});

describe('writeStoredJson', () => {
  it('serializes the value as JSON', () => {
    const storage = fakeStorage();
    writeStoredJson(storage, 'key', { a: [1, 2] });
    expect(storage.data.key).toBe('{"a":[1,2]}');
  });

  it('does nothing when storage is unavailable', () => {
    expect(() => writeStoredJson(null, 'key', 1)).not.toThrow();
  });

  it('swallows storage errors', () => {
    const broken = { setItem: () => { throw new Error('denied'); } };
    expect(() => writeStoredJson(broken, 'key', 1)).not.toThrow();
  });
});
