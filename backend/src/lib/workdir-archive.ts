import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { getMinioBucket } from './minio-client.js';

const execFileAsync = promisify(execFile);

export const WORKDIR_ARCHIVE_BUCKET =
  process.env.WORKDIR_ARCHIVE_BUCKET ?? 'lemniscate-workdir-archives';

export function archiveObjectKey(workdir: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `workdirs/${basename(workdir)}-${stamp}.tar.gz`;
}

async function stageTarball(workdir: string, staging: string): Promise<string> {
  const tarball = join(staging, 'workdir.tar.gz');
  await execFileAsync('tar', ['-czf', tarball, '-C', workdir, '.']);
  return tarball;
}

/**
 * Best-effort snapshot of a finished task's workdir into MinIO, silently.
 * Archives only — the caller (agent-git's cleanupWorkdir) stays responsible
 * for deleting the workdir — and never throws or logs: workdir cleanup must
 * succeed even when MinIO is down or the tmpdir is exhausted.
 */
export async function archiveWorkdirToMinio(workdir: string): Promise<void> {
  try {
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
