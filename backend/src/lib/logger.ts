// Structured JSON logging for the API server and BullMQ worker. A single
// Pino instance is shared across both processes and passed to Fastify's
// logger option so request-scoped logs (request.log) flow through the same
// pipeline. Every log line is a single JSON object on stdout — the shape
// modern log aggregators (ELK, Datadog, Loki) ingest without parsing.
//
// Sensitive data is scrubbed two complementary ways:
// 1. By KEY NAME — Pino's `redact` (configured below) replaces values of
//    well-known credential fields (password, token, apiKey, …) with
//    '[redacted]' before they are serialized.
// 2. By VALUE — sentry.ts `scrubEvent` + MONITORED_SECRETS redact raw secret
//    strings that may appear inside free-text fields before Sentry events
//    leave the process.
//
// In test mode the logger is silent so unit-test output stays clean. To
// assert on log output, mock this module (see tests/logger.test.ts).

import pino, { type Logger } from 'pino';
import { config } from '../config.js';

// Pino redact paths: field names whose values are replaced with '[redacted]'
// in every emitted log line. Top-level request headers plus wildcard patterns
// that catch common credential keys at any nesting depth.
// Exported so tests can build a logger with the same config and a capture
// stream (the shared singleton is silent in test mode).
export const REDACT_PATHS = [
  // Fastify auto-logs req/res objects on every request lifecycle event.
  'req.headers.authorization',
  'req.headers.cookie',
  // Common credential field names — both top-level and at any nesting depth.
  'password',
  '*.password',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
];

export const REDACT_CENSOR = '[redacted]';

function buildLogger(): Logger {
  if (config.NODE_ENV === 'test') {
    // Silent logger: methods exist (so callers don't crash) but nothing is
    // written to stdout, keeping test output clean.
    return pino({ level: 'silent' });
  }
  return pino({
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  });
}

export const logger: Logger = buildLogger();

/** Create a child logger with persistent context bindings (e.g. { jobId, taskId }). */
export function createLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
