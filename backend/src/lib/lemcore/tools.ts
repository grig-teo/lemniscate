// Tool implementations for the lemcore agent executor.
// Each tool is jailed to the workdir (path escapes rejected),
// outputs are capped at 8_000 chars, and secrets are redacted.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../utils.js';

export const TOOL_MAX_OUTPUT_CHARS = 8_000;
export const BASH_TIMEOUT_MS = 120_000;
export const GLOB_MAX_RESULTS = 200;

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'multi_edit'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'list_dir'
  | 'web_search'
  | 'graph_query'
  | 'graph_impact'
  | 'graph_neighbors'
  | 'graph_search'
  | 'load_skill';

export interface ToolResult {
  tool: ToolName;
  title: string;
  detail?: string;
  outputPreview: string;
  durationMs: number;
  error?: string;
}

// Returns the absolute path if it stays inside workdir; throws on escape.
export function jailPath(workdir: string, relPath: string): string {
  const resolved = path.resolve(workdir, relPath);
  if (!resolved.startsWith(path.resolve(workdir) + path.sep) && resolved !== path.resolve(workdir)) {
    throw new Error(`path escape rejected: ${relPath}`);
  }
  return resolved;
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
  const end = limit !== undefined ? start + limit : undefined;
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
  const existing = await fs.readFile(absPath, 'utf8');
  if (!existing.includes(search)) {
    const preview = existing.split('\n').filter(l => l.trim()).slice(0, 5).join('\n');
    throw new Error(`edit_file: search string not found in ${relPath}. First lines:\n${preview}`);
  }
  const count = (existing.match(new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
  if (count !== 1) {
    throw new Error(`edit_file: expected exactly 1 match, found ${count} in ${relPath}`);
  }
  const updated = existing.replace(search, () => replace);
  await fs.writeFile(absPath, updated, 'utf8');
  return {
    tool: 'edit_file',
    title: relPath,
    outputPreview: truncate(redactSecrets(`replaced 1 occurrence (${search.length} chars)`, secrets)),
    durationMs: Date.now() - startMs,
  };
}

export async function toolMultiEdit(
  workdir: string,
  relPath: string,
  edits: { search: string; replace: string }[],
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  const absPath = jailPath(workdir, relPath);
  let content = await fs.readFile(absPath, 'utf8');
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
    content = content.replace(search, () => replace);
    applied += 1;
  }
  await fs.writeFile(absPath, content, 'utf8');
  return {
    tool: 'multi_edit',
    title: relPath,
    outputPreview: truncate(redactSecrets(`applied ${applied} edit(s)`, secrets)),
    durationMs: Date.now() - startMs,
  };
}

// Only true infrastructure failures (timeout, spawn error) are tool errors;
// a non-zero exit (grep no-match, ls missing file, failing tests) is a normal
// result the agent should see in the output and act on — not a consecutive
// tool failure that counts toward MAX_TOOL_FAILURES.
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
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { cwd: workdir, timeout: BASH_TIMEOUT_MS }, (err, stdout, stderr) => {
      const combined = [stdout ?? '', stderr ?? ''].join('');
      const capped = truncate(redactSecrets(combined, secrets));
      resolve({
        tool: 'bash',
        title: command.length > 80 ? `${command.slice(0, 80)}…` : command,
        outputPreview: capped,
        durationMs: Date.now() - startMs,
        error: isRealBashError(err) ? err!.message : undefined,
      });
    });
  });
}

export async function toolGrep(
  workdir: string,
  pattern: string,
  pathArg?: string,
  globArg?: string,
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  const searchPath = pathArg ? jailPath(workdir, pathArg) : workdir;
  const args = ['-n', '--color=never', pattern, searchPath];
  if (globArg) args.push('--glob', globArg);
  return new Promise((resolve) => {
    execFile('rg', args, { cwd: workdir, timeout: 30_000 }, (err, stdout) => {
      const preview = truncate(redactSecrets(stdout ?? '', secrets));
      resolve({
        tool: 'grep',
        title: `grep ${pattern}${pathArg ? ` in ${pathArg}` : ''}`,
        outputPreview: preview || '(no matches)',
        durationMs: Date.now() - startMs,
        // exit 1 (no matches) is not an error; only timeout/spawn failures are
        error: err && typeof err.code === 'string' && !stdout ? err.message : undefined,
      });
    });
  });
}

export async function toolGlob(
  workdir: string,
  pattern: string,
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  return new Promise((resolve) => {
    execFile('find', ['.', '-name', pattern], { cwd: workdir, maxBuffer: 1_000_000 }, (err, stdout) => {
      let results: string[] = [];
      if (!err && stdout) {
        results = stdout.split('\n').filter(Boolean).slice(0, GLOB_MAX_RESULTS);
      }
      const preview = truncate(results.join('\n'));
      resolve({
        tool: 'glob',
        title: `glob ${pattern}`,
        outputPreview: preview || '(no matches)',
        durationMs: Date.now() - startMs,
      });
    });
  });
}

export async function toolListDir(
  workdir: string,
  relPath: string,
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  const absPath = relPath ? jailPath(workdir, relPath) : workdir;
  const entries = await fs.readdir(absPath, { withFileTypes: true });
  const lines = entries
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
    .slice(0, 200);
  return {
    tool: 'list_dir',
    title: relPath || '.',
    outputPreview: truncate(redactSecrets(lines.join('\n'), secrets)),
    durationMs: Date.now() - startMs,
  };
}

// DuckDuckGo HTML search — see web-search.ts.
export async function toolWebSearch(
  query: string,
  secrets: string[] = [],
): Promise<ToolResult> {
  const startMs = Date.now();
  try {
    const { duckDuckGoSearch, formatWebSearchResults } = await import('./web-search.js');
    const hits = await duckDuckGoSearch(query);
    return {
      tool: 'web_search',
      title: query,
      outputPreview: truncate(redactSecrets(formatWebSearchResults(query, hits), secrets)),
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      tool: 'web_search',
      title: query,
      outputPreview: truncate(redactSecrets(`web_search failed: ${msg}`, secrets)),
      durationMs: Date.now() - startMs,
      error: msg,
    };
  }
}

export function truncate(text: string, maxChars: number = TOOL_MAX_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… [truncated at ${maxChars} chars]`;
}
