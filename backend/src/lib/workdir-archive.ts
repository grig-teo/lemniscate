import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { getMinioBucket } from './minio-client.js';
import { publishTaskEvent } from './task-events.js';

const execFileAsync = promisify(execFile);

export const WORKDIR_ARCHIVE_BUCKET = config.WORKDIR_ARCHIVE_BUCKET;

/** Paths excluded from the workdir tarball: large, reproducible from the
 *  remote, or build outputs that bloat the archive without aiding post-mortem
 *  inspection. Single source of truth — consumed by buildTarExcludes() (tar)
 *  and workdirSizeBytes() (the pre-stage size gate) so the two never diverge. */
export const TAR_EXCLUDES = [
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'target',
  '.gradle',
  'DerivedData',
] as const;

const EXCLUDE_SET = new Set<string>(TAR_EXCLUDES);

/** Flat `--exclude <p>` args for `tar`, in the order tar accepts them (before
 *  the file operands). One entry per exclude so nested matches (e.g. nested
 *  node_modules) are also excluded by tar's path-component matching. */
export function buildTarExcludes(): string[] {
  return TAR_EXCLUDES.flatMap((p) => ['--exclude', p]);
}

export function archiveObjectKey(workdir: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `workdirs/${basename(workdir)}-${stamp}.tar.gz`;
}

/** Total size in bytes of the workdir after applying the same excludes tar
 *  uses. Walks the tree without descending into excluded subtrees so a huge
 *  node_modules is never traversed. Portable (no `du --exclude`, which BusyBox
 *  lacks in the Alpine worker image). Throws if the workdir is missing —
 *  caught by the best-effort archive caller. */
export async function workdirSizeBytes(workdir: string): Promise<number> {
  let total = 0;
  const stack: string[] = [workdir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const skipped = EXCLUDE_SET.has(entry.name);
      if (entry.isDirectory()) {
        if (!skipped) stack.push(full);
        continue;
      }
      if (skipped) continue;
      total += (await stat(full)).size;
    }
  }
  return total;
}

function archiveMaxBytes(): number {
  return config.WORKDIR_ARCHIVE_MAX_MB * 1024 * 1024;
}

async function stageTarball(workdir: string, staging: string): Promise<string> {
  const tarball = join(staging, 'workdir.tar.gz');
  await execFileAsync('tar', [...buildTarExcludes(), '-czf', tarball, '-C', workdir, '.']);
  return tarball;
}

async function emitSkipMarker(taskId: string | undefined, bytes: number): Promise<void> {
  if (taskId === undefined) return;
  await publishTaskEvent(taskId, 'log', {
    line: `archive_skipped_size: ${bytes} bytes exceeds ${config.WORKDIR_ARCHIVE_MAX_MB}MB cap`,
  }).catch(() => {});
}

/**
 * Best-effort snapshot of a finished task's workdir into MinIO, silently.
 * Excludes .git/node_modules/build outputs, skips (with a task event marker)
 * workdirs over WORKDIR_ARCHIVE_MAX_MB, and is a no-op when archiving is
 * disabled or MinIO is down. Never throws: workdir cleanup must succeed even
 * when MinIO is down or the tmpdir is exhausted. The caller (cleanupWorkdir)
 * stays responsible for deleting the workdir.
 */
export async function archiveWorkdirToMinio(workdir: string, taskId?: string): Promise<void> {
  if (!config.WORKDIR_ARCHIVE_ENABLED) return;
  try {
    const bytes = await workdirSizeBytes(workdir);
    if (bytes > archiveMaxBytes()) {
      await emitSkipMarker(taskId, bytes);
      return;
    }
    const ctx = await getMinioBucket(WORKDIR_ARCHIVE_BUCKET);
    if (!ctx) return;
    const staging = await mkdtemp(join(tmpdir(), 'lemniscate-workdir-archive-'));
    try {
      const tarball = await stageTarball(workdir, staging);
      await ctx.client.fPutObject(WORKDIR_ARCHIVE_BUCKET, archiveObjectKey(workdir), tarball);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // best-effort: archiving must never break workdir cleanup
  }
}