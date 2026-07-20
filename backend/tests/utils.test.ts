import { describe, expect, it } from 'vitest';
import { errorMessage, redactSecrets, sleep } from '../src/lib/utils.js';

// Locking tests for the shared micro-utilities that were duplicated across
// agent-loop.ts (sanitize/errorMessage/sleep), llm-client.ts (scrubApiKey/
// sleep) and pull-requests.ts (scrub).

describe('redactSecrets', () => {
  it('replaces every occurrence of each secret', () => {
    expect(redactSecrets('token abc token', ['token'])).toBe('[redacted] abc [redacted]');
  });

  it('handles multiple secrets', () => {
    expect(redactSecrets('a1 b2 a1', ['a1', 'b2'])).toBe('[redacted] [redacted] [redacted]');
  });

  it('skips empty secrets instead of splitting the text apart', () => {
    expect(redactSecrets('untouched', [''])).toBe('untouched');
  });

  it('returns the text unchanged when no secret matches', () => {
    expect(redactSecrets('hello', ['xyz'])).toBe('hello');
  });
});

describe('errorMessage', () => {
  it('uses .message for Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const started = Date.now();
    await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
