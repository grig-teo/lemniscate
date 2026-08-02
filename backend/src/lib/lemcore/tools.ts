// Tool implementations for the lemcore agent executor.
// Each tool is jailed to the workdir (path escapes rejected),
// outputs are capped at 8_000 chars, and secrets are redacted.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../utils.js';
import { enhanceErrorOutput } from './error-hints.js';
import { buildEditDiff } from './edit-diff.js';

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
  | 'spawn_subagent'
  | 'think';

export interface ToolResult {
  tool: ToolName;
  title: string;
  detail?: string;
  outputPreview: string;
  durationMs: number;
  error?: string;
  /** Unified before/after diff for file edit/write results (Show details). */
  diff?: string;
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

// Reads a jailed path as UTF-8 text, rejecting directories with an actionable
// error before Node throws its raw "EISDIR: illegal operation on a directory,
// open '<abs path>'" (which leaks the workdir internals into the console and
// tells the agent nothing about which argument was wrong). An empty relPath
// resolves to the workdir root — a directory — so it is rejected here too.
// Both file-content tools (read_file / write_file's prior-content snapshot)
// and the edit pipeline (edit-helpers.prepareEditContent) share this helper
// so the message is identical everywhere (AGENTS.md §6).
export async function readFileTarget(
  absPath: string,
  relPath: string,
  toolName: string,
): Promise<string> {
  const stat = await fs.stat(absPath);
  if (stat.isDirectory()) {
    const shown = relPath.trim() || '(empty path — resolves to the workdir root)';
    throw new Error(`${toolName}: "${shown}" is a directory, not a file — pass a file path`);
  }
  return fs.readFile(absPath, 'utf8');
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
  const content = await readFileTarget(absPath, relPath, 'read_file');
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
  // Capture prior content (null when the file is new) so the console's
  // "Show details" view can render an added/deleted line diff. Directories
  // are NOT "new files": stat them first so writing over one fails below
  // with the actionable message instead of a raw EISDIR.
  let priorContent: string | null = null;
  try {
    priorContent = await readFileTarget(absPath, relPath, 'write_file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    /* new file — diff from /dev/null */
  }
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  try {
    await fs.writeFile(absPath, content, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EISDIR') {
      throw new Error(`write_file: "${relPath}" is a directory, not a file — pass a file path`);
    }
    throw err;
  }
  return {
    tool: 'write_file',
    title: relPath,
    outputPreview: truncate(redactSecrets(`wrote ${content.length} chars`, secrets)),
    durationMs: Date.now() - startMs,
    diff: buildEditDiff({ relPath, oldContent: priorContent, newContent: content }),
  };
}

// Edit-content helpers live in edit-helpers.ts (single source of truth for
// edit validation). Re-exported here so existing importers using `tools.js`
// keep working.
export { prepareEditContent, applySingleEdit, applyMultiEdit } from './edit-helpers.js';

// Only true infra failures (timeout, spawn error) are tool errors; a non-zero
// exit (grep no-match, missing file, failing tests) is a normal result the
// agent should see and act on — not a counted tool failure.
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

// The `think` tool: a mid-loop scratchpad (Anthropic "think" tool pattern).
// The model calls it to reason before edits/finishing. It executes nothing —
// it just echoes the thought into the transcript so it survives compaction
// and is visible to the model on the next turn. A no-cost reasoning aid.
export function toolThink(thought: string): ToolResult {
  return {
    tool: 'think',
    title: 'think',
    outputPreview: thought,
    durationMs: 0,
  };
}

// Public API re-exports: these tools live in split modules but are part of the
// lemcore tools surface, so existing importers can keep using `tools.js`.
export { toolGrep, toolGlob, toolListDir, toolWebSearch } from './explore-tools.js';
export { toolUndoEdit } from './edit-checkpoint.js';
export { toolTodoWrite, getTodoList, setTodoList, resetTodoList } from './todo-store.js';
