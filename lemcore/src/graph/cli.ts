// Thin process wrapper around the code-review-graph CLI (v2.3.x).
// Fail-soft: missing binary / non-zero exit never throws to callers.
//
// Upstream argparse notes (v2.3.7):
// - --data-dir is only on build/update/status/watch/visualize/wiki/…
// - query/impact/search/architecture rely on CRG_DATA_DIR or registry
// - impact --files uses nargs='+' → one flag, many values

import { execFile } from 'node:child_process';
import type { CliRunResult, CliRunner } from './types.js';

export const DEFAULT_CLI = 'code-review-graph';
export const DEFAULT_BUILD_TIMEOUT_MS = 120_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

/** Patterns accepted by `code-review-graph query` (v2.3.7 choices=). */
export const CRG_QUERY_PATTERNS = [
  'callers_of',
  'callees_of',
  'imports_of',
  'importers_of',
  'children_of',
  'tests_for',
  'inheritors_of',
  'file_summary',
] as const;

export type CrgQueryPattern = (typeof CRG_QUERY_PATTERNS)[number];

export function defaultCliRunner(
  cliPath: string = DEFAULT_CLI,
): CliRunner {
  return (args, opts) =>
    new Promise((resolve) => {
      execFile(
        cliPath,
        args,
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, ...(opts.env ?? {}) },
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
            return;
          }
          const code =
            typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? ((err as { code: number }).code as number)
              : null;
          const notFound =
            (err as NodeJS.ErrnoException).code === 'ENOENT' ||
            /not found|ENOENT/i.test(err.message);
          resolve({
            ok: false,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code,
            error: notFound
              ? `code-review-graph CLI not found (${cliPath})`
              : err.message,
          });
        },
      );
    });
}

function crgEnv(dataDir: string): NodeJS.ProcessEnv {
  return { CRG_DATA_DIR: dataDir };
}

export async function runGraphBuild(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  timeoutMs: number,
): Promise<CliRunResult> {
  return run(
    ['build', '--repo', repoRoot, '--data-dir', dataDir, '--quiet', '--skip-flows'],
    { cwd: repoRoot, timeoutMs, env: crgEnv(dataDir) },
  );
}

export async function runGraphStatus(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  timeoutMs: number,
): Promise<CliRunResult> {
  return run(['status', '--repo', repoRoot, '--data-dir', dataDir, '--json'], {
    cwd: repoRoot,
    timeoutMs,
    env: crgEnv(dataDir),
  });
}

/** Export full graph JSON via visualize (writes `<dataDir>/graph.json`). */
export async function runGraphExportJson(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  timeoutMs: number,
): Promise<CliRunResult> {
  return run(
    ['visualize', '--repo', repoRoot, '--data-dir', dataDir, '--format', 'json'],
    { cwd: repoRoot, timeoutMs, env: crgEnv(dataDir) },
  );
}

export async function runGraphArchitecture(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  timeoutMs: number,
): Promise<CliRunResult> {
  // No --data-dir on architecture (v2.3.7); CRG_DATA_DIR + build registry.
  return run(['architecture', '--repo', repoRoot, '--detail-level', 'minimal'], {
    cwd: repoRoot,
    timeoutMs,
    env: crgEnv(dataDir),
  });
}

export async function runGraphQuery(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  pattern: string,
  target: string,
  timeoutMs: number,
): Promise<CliRunResult> {
  return run(['query', pattern, target, '--repo', repoRoot], {
    cwd: repoRoot,
    timeoutMs,
    env: crgEnv(dataDir),
  });
}

export async function runGraphImpact(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  files: string[],
  depth: number,
  timeoutMs: number,
): Promise<CliRunResult> {
  const args = ['impact', '--repo', repoRoot, '--depth', String(depth)];
  if (files.length > 0) {
    // Single --files followed by all paths (argparse nargs='+').
    args.push('--files', ...files);
  }
  return run(args, {
    cwd: repoRoot,
    timeoutMs,
    env: crgEnv(dataDir),
  });
}

export async function runGraphSearch(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  query: string,
  timeoutMs: number,
): Promise<CliRunResult> {
  return run(['search', query, '--repo', repoRoot, '--limit', '20'], {
    cwd: repoRoot,
    timeoutMs,
    env: crgEnv(dataDir),
  });
}
