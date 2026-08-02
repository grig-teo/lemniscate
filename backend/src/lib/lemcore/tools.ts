// Tool implementations for the lemcore agent executor.
// Each tool is jailed to the workdir (path escapes rejected),
// outputs are capped at 8_000 chars, and secrets are redacted.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../utils.js';
import { checkpointEdit } from './edit-checkpoint.js';
import { enhanceErrorOutput } from './error-hints.js';

export { enhanceErrorOutput } from './error-hints.js';

export const TOOL_MAX_OUTPUT_CHARS = 8_000;
export const BASH_TIMEOUT_MS = 120_000;
export const GLOB_MAX_RESULTS = 200;

// Circuit breaker: never run commands that would wipe the filesystem, the
// home dir, or raw block devices. Module-level so the regex isn't rebuilt on
// every call. Matches: rm -rf with any dangerous absolute path / ~ / $HOME,
// `find / -delete`, mkfs, chmod -R 000 /, fork bombs, and force pushes.
const CATASTROPHIC_RE = new RegExp(
  '\\brm\\s+-rf?\\s+(/|\\$HOME|~|/etc|/usr|/var|/home|/boot|/sys|/proc)' +
    '|\\bfind\\s+/\\s+.*-delete' +
    '|\\bmkfs\\b' +
    '|\\bchmod\\s+-R\\s+000\\s+/' +
    '|:\\(\\)\\s*\\{\\s*:\\|:&\\s*\\}\\s*;:' +
    '|\\bgit\\s+push\\s+(-f|--force|--force-with-lease)',
  'i',
);

// Post-processes bash error output to append a one-line actionable hint for
// common failure classes (lives in error-hints.ts to keep this file slim).


export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'multi_edit'
  | 'undo_edit'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'list_dir'
  | 'web_search'
  | 'graph_query'
  | 'graph_impact'
  | 'graph_neighbors'
  | 'graph_search'
  | 'load_skill'
  | 'todo_write'
  | 'spawn_subagent';

export interface ToolResult {
  tool: ToolName;
  title: string;
  detail?: string;
  outputPreview: string;
  durationMs: number;
  error?: string;
}

// Cache the realpath of each workdir; realpathSync on every jail check would
// dominate tool latency for hot loops, and the workdir doesn't move mid-run.
const workdirRealpathCache = new Map<string, string>();
function resolvedWorkdir(workdir: string): string {
  let resolved = workdirRealpathCache.get(workdir);
  if (!resolved) {
    resolved = fsSync.realpathSync(workdir);
    workdirRealpathCache.set(workdir, resolved);
  }
  return resolved;
}

// Returns the absolute path if it stays inside workdir; throws on escape.
// Resolves symlinks so a symlink inside workdir pointing outside is rejected.
// For not-yet-existing paths (write_file/edit creating a file/dir), walks up
// to the nearest existing ancestor and re-appends the missing tail, so a new
// file nested several dirs deep is still correctly jailed.
export function jailPath(workdir: string, relPath: string): string {
  const target = path.resolve(workdir, relPath);
  const resolvedWork = resolvedWorkdir(workdir);
  let resolvedTarget: string;
  try {
    resolvedTarget = fsSync.realpathSync(target);
  } catch {
    // File doesn't exist yet — resolve the nearest existing ancestor, then
    // re-append the missing tail relative to that ancestor.
    let dir = path.dirname(target);
    while (true) {
      try {
        const real = fsSync.realpathSync(dir);
        resolvedTarget = path.join(real, path.relative(dir, target));
        break;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) {
          // Reached the filesystem root without resolving — fall back to the
          // raw target (the contains check below will reject it if external).
          resolvedTarget = target;
          break;
        }
        dir = parent;
      }
    }
  }
  if (!resolvedTarget.startsWith(resolvedWork + path.sep) && resolvedTarget !== resolvedWork) {
    throw new Error(`path escapes workdir: ${relPath}`);
  }
  return resolvedTarget;
}

export async function toolReadFile(
  workdir: string,
  relPath: string,
  offset?: number,
  limit?: number,
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  const absPath = jailPath(workdir, relPath);
  const content = await fs.readFile(absPath, 'utf8');
  const lines = content.split('\n');
  const start = offset ?? 0;
  // Default cap (100 lines) so an unbounded read doesn't dump a whole file
  // into the transcript; the agent can pass an explicit limit to read more.
  const effectiveLimit = limit !== undefined ? limit : 100;
  const end = start + effectiveLimit;
  const slice = lines.slice(start, end);
  const preview = slice.join('\n');
  return {
    tool: 'read_file',
    title: relPath,
    outputPreview: truncate(redactSecrets(preview, secrets)),
    durationMs: Date.now() - startMs,
  };
}

export async function toolWriteFile(
  workdir: string,
  relPath: string,
  content: string,
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  const absPath = jailPath(workdir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf8');
  return {
    tool: 'write_file',
    title: relPath,
    outputPreview: truncate(redactSecrets(`wrote ${content.length} chars`, secrets)),
    durationMs: Date.now() - startMs,
  };
}

/**
 * Shared edit-content preparation for edit_file / multi_edit: reads the file,
 * runs the caller's validation + content transform, and checkpoints the
 * pre-edit content for undo_edit. Does NOT write — the caller (or
 * verifyEditWithFallback) owns the write via lintAndMaybeRevert. Exported so
 * executeTool can route through multi-sample verification when a runtime
 * context is available, reusing the exact same validation logic.
 */
export async function prepareEditContent(
  workdir: string,
  relPath: string,
  compute: (original: string) => string,
): Promise<{ originalContent: string; newContent: string }> {
  const absPath = jailPath(workdir, relPath);
  const originalContent = await fs.readFile(absPath, 'utf8');
  const newContent = compute(originalContent);
  checkpointEdit(workdir, relPath, originalContent);
  return { originalContent, newContent };
}

/** Compute the result of an edit_file search/replace, with full validation. */
export function applySingleEdit(
  relPath: string,
  original: string,
  search: string,
  replace: string,
): string {
  if (!original.includes(search)) {
    const preview = original.split('\n').filter((l) => l.trim()).slice(0, 5).join('\n');
    throw new Error(`edit_file: search string not found in ${relPath}. First lines:\n${preview}`);
  }
  const count = countOccurrences(original, search);
  if (count !== 1) {
    throw new Error(`edit_file: expected exactly 1 match, found ${count} in ${relPath}`);
  }
  // Replacer function so $ patterns (e.g. `$&`, `$1`) in `replace` are literal.
  return original.replace(search, () => replace);
}

/** Compute the result of a multi_edit sequence, with full validation. */
export function applyMultiEdit(
  relPath: string,
  original: string,
  edits: { search: string; replace: string }[],
): string {
  let content = original;
  edits.forEach(({ search, replace }, i) => {
    if (!content.includes(search)) {
      throw new Error(`multi_edit: search string not found in ${relPath} (edit ${i + 1})`);
    }
    const count = countOccurrences(content, search);
    if (count !== 1) {
      throw new Error(`multi_edit: expected exactly 1 match for edit ${i + 1}, found ${count}`);
    }
    content = content.replace(search, () => replace);
  });
  return content;
}

function countOccurrences(haystack: string, needle: string): number {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (haystack.match(new RegExp(escaped, 'g')) ?? []).length;
}

// Only true infra failures (timeout, spawn error) are tool errors; a non-zero
// exit (grep no-match, missing file, failing tests) is a normal result the
// agent should see and act on — not a consecutive failure toward MAX_TOOL_FAILURES.
function isRealBashError(err: Error | null): boolean {
  if (!err) return false;
  const e = err as unknown as { killed?: boolean; signal?: string; code?: string | number };
  if (e.killed && e.signal) return true;
  if (typeof e.code === 'string') return true;
  return false;
}

export async function toolBash(
  workdir: string,
  command: string,
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  // Circuit breaker: reject before execFile so the model gets an immediate,
  // actionable error and can pick a targeted command instead.
  if (CATASTROPHIC_RE.test(command)) {
    return {
      tool: 'bash',
      title: 'blocked',
      durationMs: 0,
      outputPreview:
        'BLOCKED: this command matches a catastrophic pattern (rm -rf /, rm -rf ~, mkfs, find / -delete, chmod -R 000 /, fork bomb, or git push --force). Use a more targeted command.',
      error: 'command blocked by circuit breaker',
    };
  }
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-c', command],
      { cwd: workdir, timeout: BASH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const combined = stdout + (stderr ? `\n${stderr}` : '');
        const trimmed = combined.trim() || '(ran successfully, no output)';
        const redacted = redactSecrets(trimmed, secrets);
        // Append an actionable hint for known error classes when the command
        // produced stderr/failed, so the model gets a nudge toward the fix.
        const output = isRealBashError(err) || (err && (err as { code?: number }).code !== 0)
          ? enhanceErrorOutput(redacted)
          : redacted;
        const capped = truncate(output);
        resolve({
          tool: 'bash',
          title: command.length > 80 ? `${command.slice(0, 80)}…` : command,
          outputPreview: capped,
          durationMs: Date.now() - startMs,
          error: isRealBashError(err) ? err!.message : undefined,
        });
      },
    );
  });
}

export function truncate(text: string, maxChars: number = TOOL_MAX_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  // Too small for a meaningful head + tail split — just slice.
  if (maxChars < 50) return text.slice(0, maxChars);
  // Keep a head and a tail so both the start of a log and the final error
  // lines (which usually carry the actionable failure) survive truncation.
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head - 20;
  return `${text.slice(0, head)}\n… [truncated] …\n${text.slice(-tail)}`;
}

// Public API re-exports: these tools live in split modules but are part of the
// lemcore tools surface, so existing importers can keep using `tools.js`.
export { toolGrep, toolGlob, toolListDir, toolWebSearch } from './explore-tools.js';
export { toolUndoEdit } from './edit-checkpoint.js';
export { toolTodoWrite, getTodoList, setTodoList, resetTodoList } from './todo-store.js';
