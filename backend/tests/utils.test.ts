import { describe, expect, it } from 'vitest';
import { errorMessage, redactSecrets, redisEndpointForLog, sleep } from '../src/lib/utils.js';

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

describe('redisEndpointForLog', () => {
  it('strips credentials, keeping only host and port', () => {
    expect(redisEndpointForLog('redis://:s3cret@redis.internal:6380')).toBe('redis.internal:6380');
    expect(redisEndpointForLog('redis://user:s3cret@redis.internal:6380')).toBe('redis.internal:6380');
  });

  it('keeps the default port explicit when the URL omits it', () => {
    expect(redisEndpointForLog('redis://localhost')).toBe('localhost:6379');
  });

  it('never leaks credentials even for unparseable URLs', () => {
    const out = redisEndpointForLog('not a url :s3cret@');
    expect(out).not.toContain('s3cret');
  });
});
