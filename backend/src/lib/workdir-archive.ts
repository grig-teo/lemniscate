import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getMinioClient } from './minio-client.js';

export const WORKDIR_ARCHIVE_BUCKET = 'workdir-archives';

const execFileAsync = promisify(execFile);

function archiveObjectKey(workdir: string): string {
  const folder = path.basename(workdir).replace(/[^a-zA-Z0-9._-]/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${folder}/${stamp}.tar.gz`;
}

async function createTarball(workdir: string, outFile: string): Promise<void> {
  await execFileAsync('tar', [
    '-czf', outFile,
    '-C', path.dirname(workdir),
    path.basename(workdir),
  ]);
}

async function ensureBucket(client: ReturnType<typeof getMinioClient>): Promise<void> {
  if (!client) return;
  const exists = await client.bucketExists(WORKDIR_ARCHIVE_BUCKET).catch(() => false);
  if (!exists) await client.makeBucket(WORKDIR_ARCHIVE_BUCKET);
}

async function uploadSnapshot(outFile: string, key: string): Promise<void> {
  const client = getMinioClient();
  if (!client) return;
  await ensureBucket(client);
  await client.fPutObject(WORKDIR_ARCHIVE_BUCKET, key, outFile, {
    'Content-Type': 'application/gzip',
  });
}

/**
 * Snapshot the workdir into MinIO as a timestamped tar.gz (best-effort,
 * silent — never logs and never throws), then remove the local directory.
 * The tarball is streamed from disk via fPutObject so large checkouts
 * (.git, node_modules) are not buffered in memory.
 */
export async function cleanupWorkdir(workdir: string): Promise<void> {
  const staging = await mkdtemp(path.join(tmpdir(), 'workdir-archive-'));
  const outFile = path.join(staging, 'snapshot.tar.gz');
  try {
    await createTarball(workdir, outFile);
    await uploadSnapshot(outFile, archiveObjectKey(workdir));
  } catch {
    // best-effort: archiving failures must never block cleanup
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}
