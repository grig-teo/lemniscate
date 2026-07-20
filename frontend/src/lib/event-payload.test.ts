import { describe, expect, it } from 'vitest';

import {
  firstStringField,
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
