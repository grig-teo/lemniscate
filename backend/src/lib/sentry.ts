// Opt-in error reporting (Sentry). Disabled by default: without SENTRY_DSN
// the reporter is a no-op and the @sentry/node SDK is never imported, so
// self-hosted installs pay nothing for it. When enabled, every event passes
// through scrubEvent so configured secrets (LLM keys, tokens) are redacted
// before anything leaves the process.

import { redactSecrets } from './utils.js';

export interface ErrorReporter {
  enabled: boolean;
  captureException: (err: unknown, context?: Record<string, unknown>) => void;
}

interface SentrySdkLike {
  init: (options: Record<string, unknown>) => void;
  captureException: (err: unknown, hint?: Record<string, unknown>) => void;
}

type SentryLoader = () => Promise<SentrySdkLike>;

const noopReporter: ErrorReporter = {
  enabled: false,
  captureException: () => {},
};

// Deep-copies the event, redacting every occurrence of each secret in every
// string. Non-string values pass through unchanged; the input is not mutated.
export function scrubEvent<T>(event: T, secrets: string[]): T {
  if (typeof event === 'string') return redactSecrets(event, secrets) as T;
  if (Array.isArray(event)) {
    return event.map((item) => scrubEvent(item, secrets)) as T;
  }
  if (typeof event === 'object' && event !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      out[key] = scrubEvent(value, secrets);
    }
    return out as T;
  }
  return event;
}

async function loadSentrySdk(): Promise<SentrySdkLike> {
  return (await import('@sentry/node')) as unknown as SentrySdkLike;
}

let activeReporter: ErrorReporter = noopReporter;

export function getErrorReporter(): ErrorReporter {
  return activeReporter;
}

// Called once at process start (API and worker). sdkLoader is injectable so
// tests never import the real SDK.
export async function initErrorReporting(
  dsn: string | undefined,
  secrets: string[],
  sdkLoader: SentryLoader = loadSentrySdk,
): Promise<ErrorReporter> {
  if (!dsn) {
    activeReporter = noopReporter;
    return activeReporter;
  }
  const sdk = await sdkLoader();
  sdk.init({
    dsn,
    beforeSend: (event: Record<string, unknown>) => scrubEvent(event, secrets),
  });
  activeReporter = {
    enabled: true,
    captureException: (err, context) => {
      sdk.captureException(err, context ? { extra: context } : undefined);
    },
  };
  return activeReporter;
}

// Convenience wrapper for call sites that don't keep the reporter around.
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  activeReporter.captureException(err, context);
}
