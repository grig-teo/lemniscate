import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { REDACT_CENSOR, REDACT_PATHS, createLogger, logger } from '../src/lib/logger.js';

// The logger module creates a shared Pino instance at import time, configured
// by NODE_ENV. In the test environment the singleton is silent (level:
// 'silent') so unit-test stdout stays clean. These tests verify:
//   1. The singleton exists with the expected Pino log-method surface.
//   2. Redaction actually replaces known credential fields before output.
//   3. createLogger produces child loggers carrying the given bindings.
//
// Redaction is verified with a throwaway Pino instance writing to an
// in-memory Writable — the shared singleton (silent) cannot produce output
// to inspect.

describe('logger singleton', () => {
  it('exports a logger with standard log levels', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.child).toBe('function');
  });

  it('is silent in the test environment so unit-test output stays clean', () => {
    expect(logger.level).toBe('silent');
  });
});

describe('createLogger', () => {
  it('returns a child logger that includes the given bindings in output', () => {
    const child = createLogger({ component: 'worker', jobId: 'j-1' });
    expect(typeof child.info).toBe('function');
    expect(typeof child.child).toBe('function');
    // The child is bound to the same silent parent in tests, but the bindings
    // are present on the child instance.
    expect(child.bindings()).toEqual({ component: 'worker', jobId: 'j-1' });
  });
});

describe('redaction', () => {
  // Captures Pino JSON output lines into an array for assertion.
  const lines: string[] = [];
  const captureStream = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void): void {
      lines.push(chunk.toString().trim());
      callback();
    },
  });

  function makeCaptureLogger(): pino.Logger {
    return pino(
      { redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR } },
      captureStream,
    );
  }

  afterEach(() => {
    lines.length = 0;
  });

  it('redacts top-level credential fields', () => {
    const log = makeCaptureLogger();
    log.info({ password: 'super-secret', apiKey: 'key-123' }, 'login attempt');
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.password).toBe(REDACT_CENSOR);
    expect(parsed.apiKey).toBe(REDACT_CENSOR);
    expect(parsed.msg).toBe('login attempt');
  });

  it('redacts nested credential fields via wildcard paths', () => {
    const log = makeCaptureLogger();
    log.info({ user: { token: 'tok-abc', name: 'alice' } }, 'session');
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.user.token).toBe(REDACT_CENSOR);
    // Non-sensitive nested fields pass through untouched.
    expect(parsed.user.name).toBe('alice');
  });

  it('does not redact fields that are not in the redact paths', () => {
    const log = makeCaptureLogger();
    log.info({ taskId: 't-1', count: 42, status: 'ok' }, 'job complete');
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.taskId).toBe('t-1');
    expect(parsed.count).toBe(42);
    expect(parsed.status).toBe('ok');
  });

  it('emits each log entry as a single-line JSON object (no embedded newlines)', () => {
    const log = makeCaptureLogger();
    log.info({ taskId: 't-1' }, 'single line');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    // Must be parseable JSON — the contract for log aggregators.
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });
});
