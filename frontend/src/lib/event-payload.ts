/**
 * Pure helpers for the loosely-typed event payloads that flow from the
 * backend task-event stream into the console log and the diff panel.
 * Payload shapes vary by producer, so every reader goes through these
 * tolerant normalizers instead of re-deriving fields locally.
 */

import type { DiffEvent } from '@/lib/selection';

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

/** Task status carried by a `status` event payload, or null. */
export function statusFromPayload(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  return firstStringField(payload, ['status']);
}

// ---------------------------------------------------------------------------
// Diff events
// ---------------------------------------------------------------------------

export interface PatchEntry {
  kind: 'patch';
  lines: string[];
}

export interface WriteEntry {
  kind: 'write';
  action: 'created' | 'modified' | 'deleted';
}

export interface FileGroup {
  path: string;
  entries: (PatchEntry | WriteEntry)[];
}

/** File path a diff event refers to ('unknown file' when undeterminable). */
export function payloadPath(payload: unknown): string {
  return (
    firstStringField(payload, ['path', 'file', 'filePath', 'filename'], { allowEmpty: false }) ??
    'unknown file'
  );
}

/** Create/modify/delete intent of a file-write notification payload. */
export function writeAction(payload: Record<string, unknown>): WriteEntry['action'] {
  const hint = [payload.action, payload.type, payload.operation, payload.change]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  if (hint.includes('creat') || hint.includes('add')) return 'created';
  if (hint.includes('delet') || hint.includes('remov')) return 'deleted';
  return 'modified';
}

function normalizeOneEvent(groups: Map<string, FileGroup>, payload: unknown): void {
  const push = (path: string, entry: PatchEntry | WriteEntry) => {
    const group = groups.get(path) ?? { path, entries: [] };
    group.entries.push(entry);
    groups.set(path, group);
  };
  if (typeof payload === 'string') {
    push(payloadPath(null), { kind: 'patch', lines: payload.split('\n') });
    return;
  }
  const record = asRecord(payload);
  if (!record) {
    push(payloadPath(null), { kind: 'write', action: 'modified' });
    return;
  }
  const path = payloadPath(record);
  const diffText = firstStringField(record, ['diff', 'patch']);
  if (diffText) {
    push(path, { kind: 'patch', lines: diffText.split('\n') });
    return;
  }
  push(path, { kind: 'write', action: writeAction(record) });
}

/**
 * Tolerant normalizer for diff-event payloads. Handles:
 * - a raw unified-diff string,
 * - { path, diff | patch } objects,
 * - file-write notifications ({ path, action | type | … }) rendered as
 *   "created/modified/deleted <path>".
 */
export function normalizeDiffEvents(events: DiffEvent[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const event of events) normalizeOneEvent(groups, event.payload);
  return [...groups.values()];
}

/** Tailwind classes coloring one unified-diff line by its leading marker. */
export function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-zinc-500';
  if (line.startsWith('+')) return 'bg-green-500/10 text-green-400';
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-400';
  if (line.startsWith('@@')) return 'text-blue-400';
  return 'text-zinc-400';
}
