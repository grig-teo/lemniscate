// Tool implementations for the lemcore agent executor.
// Each tool is jailed to the workdir (path escapes rejected),
// outputs are capped at 8_000 chars, and secrets are redacted.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../utils.js';
import { checkpointEdit, lintAndMaybeRevert } from './edit-checkpoint.js';

export const TOOL_MAX_OUTPUT_CHARS = 8_000;
export const BASH_TIMEOUT_MS = 120_000;
export const GLOB_MAX_RESULTS = 200;

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
  | 'todo_write';

export interface ToolResult {
  tool: ToolName;
  title: string;
  detail?: string;
  outputPreview: string;
  durationMs: number;
  error?: string;
}

// Returns the absolute path if it stays inside workdir; throws on escape.
// Resolves symlinks so a symlink inside workdir pointing outside is rejected.
export function jailPath(workdir: string, relPath: string): string {
  const target = path.resolve(workdir, relPath);
  const resolvedWorkdir = fsSync.realpathSync(workdir);
  let resolvedTarget: string;
  try {
    resolvedTarget = fsSync.realpathSync(target);
  } catch {
    // File doesn't exist yet (write_file/edit creating a new file): resolve the
    // parent dir and re-append the basename so new-file paths are still jailed.
    resolvedTarget = fsSync.realpathSync(path.dirname(target)) + path.sep + path.basename(target);
  }
  if (!resolvedTarget.startsWith(resolvedWorkdir + path.sep) && resolvedTarget !== resolvedWorkdir) {
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

export async function toolEditFile(
  workdir: string,
  relPath: string,
  search: string,
  replace: string,
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  const absPath = jailPath(workdir, relPath);
  const originalContent = await fs.readFile(absPath, 'utf8');
  if (!originalContent.includes(search)) {
    const preview = originalContent.split('\n').filter(l => l.trim()).slice(0, 5).join('\n');
    throw new Error(`edit_file: search string not found in ${relPath}. First lines:\n${preview}`);
  }
  const count = (originalContent.match(new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
  if (count !== 1) {
    throw new Error(`edit_file: expected exactly 1 match, found ${count} in ${relPath}`);
  }
  const updated = originalContent.replace(search, () => replace);
  // Checkpoint the pre-edit content so undo_edit can restore it.
  checkpointEdit(relPath, originalContent);
  await fs.writeFile(absPath, updated, 'utf8');
  return lintAndMaybeRevert(workdir, relPath, originalContent, updated, secrets, startMs, 'edit_file');
}

export async function toolMultiEdit(
  workdir: string,
  relPath: string,
  edits: { search: string; replace: string }[],
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  const absPath = jailPath(workdir, relPath);
  const originalContent = await fs.readFile(absPath, 'utf8');
  let content = originalContent;
  let applied = 0;
  for (const { search, replace } of edits) {
    if (!content.includes(search)) {
      throw new Error(`multi_edit: search string not found in ${relPath} (edit ${applied + 1})`);
    }
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = (content.match(new RegExp(escaped, 'g')) ?? []).length;
    if (count !== 1) {
      throw new Error(`multi_edit: expected exactly 1 match for edit ${applied + 1}, found ${count}`);
    }
    content = content.replace(search, replace);
    applied += 1;
  }
  // Checkpoint the pre-edit content so undo_edit can restore it.
  checkpointEdit(relPath, originalContent);
  await fs.writeFile(absPath, content, 'utf8');
  return lintAndMaybeRevert(workdir, relPath, originalContent, content, secrets, startMs, 'multi_edit');
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
  // Circuit breaker: never run commands that would wipe the filesystem, the
  // home dir, or raw block devices. Reject before execFile so the model gets
  // an immediate, actionable error and can pick a targeted command instead.
  const CATASTROPHIC = new RegExp(
    '\\brm\\s+-rf?\\s+/(\\s|$)|\\brm\\s+-rf?\\s+~/(\\s|$)|\\bdd\\s+if=.*of=/(dev|sd|nvme|hd)',
    'i',
  );
  if (CATASTROPHIC.test(command)) {
    return {
      tool: 'bash',
      title: 'blocked',
      durationMs: 0,
      outputPreview:
        'BLOCKED: this command matches a catastrophic pattern (rm -rf /, rm -rf ~, or dd to a device). Use a more targeted command.',
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
        const output = combined.trim() || '(ran successfully, no output)';
        const capped = truncate(redactSecrets(output, secrets));
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
