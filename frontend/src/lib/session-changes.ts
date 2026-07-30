/**
 * Session-change model: reduces the task-event `diff` stream to one row per
 * touched file (GitHub-style additions/deletions counts plus a collapsible
 * unified diff per file). Pure functions so the reducer is fully unit-tested;
 * consumed by the console header's changes badge and the ChangesDialog.
 */
import { firstStringField } from '@/lib/event-payload';
import type { TaskEventItem } from '@/lib/task-types';

/** One file the agent touched in the current session. */
export interface FileChange {
  path: string;
  /** created | modified | deleted | conflict-resolved (or any future action). */
  action: string;
  /** Latest textual diff for the file, when the backend produced one. */
  diff?: string;
  /**
   * First textual diff seen for the file. When a file was created earlier in
   * the same session, the per-event diffs are incremental; the dialog renders
   * baseDiff first so the file shows its full contents instead of a fragment.
   */
  baseDiff?: string;
}

/** Aggregated changes for the header badge and the dialog. */
export interface ChangeSummary {
  changes: FileChange[];
  count: number;
  additions: number;
  deletions: number;
}

/** One rendered line of a unified diff, GitHub-style. */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
}

/** Extract { path, diff } from a diff-event payload, or null. */
export function parseEventDiff(payload: unknown): { path: string; diff: string } | null {
  const path = firstStringField(payload, ['path']);
  const diff = firstStringField(payload, ['diff']);
  if (!path || diff === null) return null;
  return { path, diff };
}

/** A unified diff whose old side is /dev/null describes a newly created file. */
export function isCreatedDiff(diff: string): boolean {
  return diff.startsWith('--- /dev/null');
}

/** Resolve the file action: explicit `action` field, else derive from headers. */
export function deriveChangeAction(payload: unknown): string {
  const action = firstStringField(payload, ['action']);
  if (action) return action;
  const diff = firstStringField(payload, ['diff']);
  if (diff !== null) return isCreatedDiff(diff) ? 'created' : 'modified';
  return 'modified';
}

/** Count +/− lines inside hunks (file headers ---/+++ are excluded). */
export function countDiffHunkLines(diff: string | undefined): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of (diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/**
 * Fold one diff event into the per-file state. Returns the next state, or
 * null when the file should disappear (created then deleted within the same
 * session — net effect zero, like the file was never touched).
 */
export function mergeDiffEvent(
  prev: FileChange | undefined,
  payload: unknown,
): FileChange | null {
  const path = firstStringField(payload, ['path']);
  if (!path) return prev ?? null;
  const action = deriveChangeAction(payload);
  const diff = firstStringField(payload, ['diff']);
  if (action === 'deleted') {
    if (prev?.action === 'created') return null;
    return { path, action: 'deleted' };
  }
  const baseDiff = prev?.baseDiff ?? (prev?.diff !== diff ? prev?.diff : undefined);
  return { path, action, diff: diff ?? prev?.diff, baseDiff };
}

function toDiffLine(line: string, insideHunk: boolean): DiffLine {
  if (line.startsWith('@@')) return { kind: 'hunk', text: line };
  if (!insideHunk) return { kind: 'meta', text: line };
  if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) };
  return { kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line };
}

function diffTextToLines(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let sawFileHeader = false;
  let insideHunk = false;
  for (const raw of text.split('\n')) {
    const header = raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ');
    if (header) sawFileHeader = true;
    if (raw.startsWith('@@')) insideHunk = true;
    // Creation previews carry no @@ hunks ('--- /dev/null' followed by '+line'
    // rows): treat +/- rows after the file headers as content even pre-hunk.
    const preHunkContent = sawFileHeader && (raw.startsWith('+') || raw.startsWith('-'));
    if (header) lines.push({ kind: 'meta', text: raw });
    else lines.push(toDiffLine(raw, insideHunk || preHunkContent));
  }
  return lines;
}

/**
 * Render-ready lines for one file change. A file created earlier in the
 * session prepends its creation diff (baseDiff) so the dialog shows the
 * complete result; a separator row splits the two hunks sets.
 */
export function parseDiffLines(change: FileChange): DiffLine[] {
  if (change.baseDiff) {
    const separator: DiffLine = { kind: 'meta', text: '' };
    return [
      ...diffTextToLines(change.baseDiff),
      separator,
      ...diffTextToLines(change.diff ?? ''),
    ];
  }
  if (!change.diff) return [{ kind: 'meta', text: 'No textual diff available.' }];
  return diffTextToLines(change.diff);
}

/** Reduce the ordered event history to per-file changes plus +/- totals. */
export function summarizeChanges(events: TaskEventItem[]): ChangeSummary {
  const byPath = new Map<string, FileChange>();
  for (const event of events) {
    if (event.kind !== 'diff') continue;
    const path = firstStringField(event.payload, ['path']);
    if (!path) continue;
    const merged = mergeDiffEvent(byPath.get(path), event.payload);
    if (merged === null) byPath.delete(path);
    else byPath.set(path, merged);
  }
  const changes = [...byPath.values()];
  // Totals count the creation diff (baseDiff) plus the latest diff: for a file
  // created then modified in one session the final diff is incremental, so the
  // pair approximates the file's full size — the same lines the dialog renders.
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    const base = countDiffHunkLines(change.baseDiff);
    const head = countDiffHunkLines(change.diff);
    additions += base.added + head.added;
    deletions += base.removed + head.removed;
  }
  return { changes, count: changes.length, additions, deletions };
}
