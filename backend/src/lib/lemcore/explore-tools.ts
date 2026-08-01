// Read-only exploration tools (grep, glob, list_dir, web_search) for the
// lemcore agent. Split out of tools.ts to stay under the per-file line limit.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { redactSecrets } from '../utils.js';
import {
  GLOB_MAX_RESULTS,
  jailPath,
  truncate,
  type ToolResult,
} from './tools.js';

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
        // exit 1 (no matches) is not an error; only timeout/spawn failures are.
        // ripgrep exits with numeric code 2 on real errors (bad flag/regex),
        // so treat code 2 with no stdout as an error too.
        error: err && ((typeof err.code === 'string') || (typeof err.code === 'number' && err.code === 2 && !stdout)) ? err.message : undefined,
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
