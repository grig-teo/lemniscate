import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getMinioBucket, getMinioClient } from './minio-client.js';

const execFileAsync = promisify(execFile);

/**
 * Folder (object-key prefix) inside the MinIO bucket where snapshots of
 * finished task workdirs are stored before the local copy is removed.
 */
export const WORKDIR_ARCHIVE_BUCKET = 'workdir-archives';

/** Object key for a workdir snapshot: <prefix>/<name>-<YYYYMMDD-HHmmss>.tar.gz (UTC). */
export function workdirArchiveKey(name: string, date: Date = new Date()): string {
  const iso = date.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  return `${WORKDIR_ARCHIVE_BUCKET}/${name}-${stamp}.tar.gz`;
}

/**
 * Best-effort snapshot of a finished workdir into MinIO. Never throws and
 * never writes to the console. The workdir itself is untouched — removal
 * stays the job of agent-git's cleanupWorkdir.
 */
export async function archiveWorkdirToMinio(workdir: string): Promise<void> {
  try {
    await snapshotWorkdir(workdir);
  } catch {
    // Archiving must never break task cleanup.
  }
}

async function snapshotWorkdir(workdir: string): Promise<void> {
  const client = getMinioClient();
  if (!client) return;
  const name = path.basename(workdir);
  const tarball = path.join(tmpdir(), `${name}-${Date.now()}.tar.gz`);
  await execFileAsync('tar', ['-czf', tarball, '-C', path.dirname(workdir), name]);
  try {
    const body = await readFile(tarball);
    await client.putObject(getMinioBucket(), workdirArchiveKey(name), body);
  } finally {
    await rm(tarball, { force: true });
  }
}
