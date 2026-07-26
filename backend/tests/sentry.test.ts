import { describe, expect, it, vi } from 'vitest';
import {
  getErrorReporter,
  initErrorReporting,
  scrubEvent,
} from '../src/lib/sentry.js';

// Sentry is strictly opt-in: without SENTRY_DSN the reporter is a no-op and
// the SDK is never imported. When enabled, every event passes through
// scrubEvent (redactSecrets applied recursively) so LLM API keys, tokens
// and connection secrets can never leave the process via error reports.

describe('initErrorReporting', () => {
  it('returns a disabled no-op reporter when no DSN is set', async () => {
    const reporter = await initErrorReporting(undefined, ['sk-secret']);
    expect(reporter.enabled).toBe(false);
    expect(() => reporter.captureException(new Error('boom'))).not.toThrow();
  });

  it('initializes the SDK and reports errors when a DSN is set', async () => {
    const init = vi.fn();
    const captureException = vi.fn();
    const reporter = await initErrorReporting('https://key@o0.ingest.sentry.io/0', ['sk-secret'], async () => ({
      init,
      captureException,
    }));
    expect(reporter.enabled).toBe(true);
    expect(init).toHaveBeenCalledOnce();
    reporter.captureException(new Error('boom'), { jobName: 'run-task' });
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'boom' }),
      expect.objectContaining({ extra: expect.objectContaining({ jobName: 'run-task' }) }),
    );
  });

  it('wires a beforeSend hook that scrubs secrets from events', async () => {
    let options: { beforeSend?: (event: Record<string, unknown>) => unknown } = {};
    const fakeSdk = {
      init: vi.fn((opts: typeof options) => {
        options = opts;
      }),
      captureException: vi.fn(),
    };
    await initErrorReporting('https://key@o0.ingest.sentry.io/0', ['sk-secret'], async () => fakeSdk);
    const event = { message: 'failed with sk-secret', extra: { key: 'sk-secret' } };
    const scrubbed = options.beforeSend?.(event) as Record<string, unknown>;
    expect(JSON.stringify(scrubbed)).not.toContain('sk-secret');
  });
});

describe('scrubEvent', () => {
  it('redacts secrets in nested strings and leaves other values intact', () => {
    const event = {
      message: 'LLM call failed with sk-secret',
      level: 'error',
      extra: { auth: 'Bearer sk-secret', attempts: 3 },
      breadcrumbs: [{ message: 'retrying sk-secret' }, { message: 'clean' }],
      tags: { job: 'run-task' },
    };
    const scrubbed = scrubEvent(event, ['sk-secret']) as typeof event;
    expect(scrubbed.message).toBe('LLM call failed with [redacted]');
    expect(scrubbed.extra.auth).toBe('Bearer [redacted]');
    expect(scrubbed.extra.attempts).toBe(3);
    expect(scrubbed.breadcrumbs[0]?.message).toBe('retrying [redacted]');
    expect(scrubbed.breadcrumbs[1]?.message).toBe('clean');
    expect(scrubbed.tags.job).toBe('run-task');
  });

  it('does not mutate the original event', () => {
    const event = { message: 'sk-secret' };
    scrubEvent(event, ['sk-secret']);
    expect(event.message).toBe('sk-secret');
  });
});

describe('getErrorReporter', () => {
  it('reflects the last init: disabled again after a no-DSN reset', async () => {
    await initErrorReporting(undefined, []);
    const reporter = getErrorReporter();
    expect(reporter.enabled).toBe(false);
    expect(() => reporter.captureException(new Error('x'))).not.toThrow();
  });
});
