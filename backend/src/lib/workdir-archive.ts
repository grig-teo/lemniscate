// Best-effort MinIO snapshot of agent workdirs: cleanupWorkdir() archives the
// directory to the 'workdir-archives' bucket under <workdir-name>/<timestamp>.tar.gz
// BEFORE removing it locally, so a finished task's files stay retrievable.
//
// Silent by contract: nothing here is written to the task event stream or the
// console — the snapshot is an internal safety net, not user-facing output.
// Never throws and no-ops when MinIO is unconfigured, so archiving can never
// block local removal.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getMinioBucket } from './minio-client.js';

const execFileAsync = promisify(execFile);

export const WORKDIR_ARCHIVE_BUCKET = 'workdir-archives';

/** Object key: one folder per workdir, one tarball per cleanup. */
export function workdirArchiveKey(dirName: string, stamp: Date = new Date()): string {
  const safe = dirName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^\.+/, '') || 'workdir';
  return `${safe.slice(0, 80)}/${stamp.toISOString().replace(/[:.]/g, '-')}.tar.gz`;
}

async function tarDirectory(workdir: string, outFile: string): Promise<void> {
  await execFileAsync('tar', ['-czf', outFile, '-C', path.dirname(workdir), path.basename(workdir)]);
}

async function uploadSnapshot(workdir: string, client: import('minio').Client): Promise<void> {
  const outFile = path.join(os.tmpdir(), `workdir-archive-${randomUUID()}.tar.gz`);
  try {
    await tarDirectory(workdir, outFile);
    const body = await fs.readFile(outFile);
    await client.putObject(WORKDIR_ARCHIVE_BUCKET, workdirArchiveKey(path.basename(workdir)), body, body.length, {
      'Content-Type': 'application/gzip',
    });
  } finally {
    await fs.rm(outFile, { force: true }).catch(() => {});
  }
}

/** Snapshot the workdir to MinIO; no-ops when unconfigured or missing. Never throws. */
export async function archiveWorkdirToMinio(workdir: string): Promise<void> {
  try {
    const stat = await fs.stat(workdir).catch(() => null);
    if (!stat?.isDirectory()) return;
    const ctx = await getMinioBucket(WORKDIR_ARCHIVE_BUCKET);
    if (!ctx) return;
    await uploadSnapshot(workdir, ctx.client);
  } catch {
    // Silent by contract: archiving must never fail the cleanup that calls it.
  }
}
