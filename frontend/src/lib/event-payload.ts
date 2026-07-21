/**
 * Pure helpers for the loosely-typed event payloads that flow from the
 * backend task-event stream into the console log.
 * Payload shapes vary by producer, so every reader goes through these
 * tolerant normalizers instead of re-deriving fields locally.
 */

/** Narrow an unknown payload to a record, or null when it isn't one. */
export function asRecord(payload: unknown): Record<string, unknown> | null {
  if (payload && typeof payload === 'object') return payload as Record<string, unknown>;
  return null;
}

/** First string field among `keys`, or null. `allowEmpty: false` skips ''. */
export function firstStringField(
  payload: unknown,
  keys: string[],
  opts?: { allowEmpty?: boolean },
): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && (opts?.allowEmpty !== false || value)) return value;
  }
  return null;
}

/** Console log text for a `log` event payload. */
export function payloadToLogText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return firstStringField(payload, ['message', 'line', 'text']) ?? JSON.stringify(payload);
}

/**
 * One-line console text for a `diff` event payload ({ path, diff } or
 * { path, action }), or null when the shape is off. A diff from /dev/null
 * means the file was created; any other diff means modified.
 */
export function payloadToDiffText(payload: unknown): string | null {
  const path = firstStringField(payload, ['path']);
  if (!path) return null;
  const action = firstStringField(payload, ['action']);
  if (action) return `✎ ${path} (${action})`;
  const diff = firstStringField(payload, ['diff']);
  return `✎ ${path} (${diff?.startsWith('--- /dev/null') ? 'created' : 'modified'})`;
}

/** Task status carried by a `status` event payload, or null. */
export function statusFromPayload(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  return firstStringField(payload, ['status']);
}
