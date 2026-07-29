// Thin process wrapper around the code-review-graph CLI.
// Fail-soft: missing binary / non-zero exit never throws to callers.

import { execFile } from 'node:child_process';
import type { CliRunResult, CliRunner } from './types.js';

export const DEFAULT_CLI = 'code-review-graph';
export const DEFAULT_BUILD_TIMEOUT_MS = 120_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

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

export async function runGraphBuild(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  timeoutMs: number,
): Promise<CliRunResult> {
  return run(
    ['build', '--repo', repoRoot, '--data-dir', dataDir, '--quiet', '--skip-flows'],
    {
      cwd: repoRoot,
      timeoutMs,
      env: { CRG_DATA_DIR: dataDir },
    },
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
    env: { CRG_DATA_DIR: dataDir },
  });
}

export async function runGraphArchitecture(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  timeoutMs: number,
): Promise<CliRunResult> {
  return run(
    ['architecture', '--repo', repoRoot, '--data-dir', dataDir, '--detail-level', 'minimal'],
    {
      cwd: repoRoot,
      timeoutMs,
      env: { CRG_DATA_DIR: dataDir },
    },
  );
}

export async function runGraphQuery(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  pattern: string,
  target: string,
  timeoutMs: number,
): Promise<CliRunResult> {
  return run(
    ['query', pattern, target, '--repo', repoRoot, '--data-dir', dataDir],
    {
      cwd: repoRoot,
      timeoutMs,
      env: { CRG_DATA_DIR: dataDir },
    },
  );
}

export async function runGraphImpact(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  files: string[],
  depth: number,
  timeoutMs: number,
): Promise<CliRunResult> {
  const args = [
    'impact',
    '--repo',
    repoRoot,
    '--data-dir',
    dataDir,
    '--depth',
    String(depth),
  ];
  for (const f of files) {
    args.push('--files', f);
  }
  return run(args, {
    cwd: repoRoot,
    timeoutMs,
    env: { CRG_DATA_DIR: dataDir },
  });
}

export async function runGraphSearch(
  run: CliRunner,
  repoRoot: string,
  dataDir: string,
  query: string,
  timeoutMs: number,
): Promise<CliRunResult> {
  return run(
    ['search', query, '--repo', repoRoot, '--data-dir', dataDir, '--limit', '20'],
    {
      cwd: repoRoot,
      timeoutMs,
      env: { CRG_DATA_DIR: dataDir },
    },
  );
}
