import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = promisify(execFileCb);

const mocks = vi.hoisted(() => ({
  getMinioBucket: vi.fn(),
  putObject: vi.fn(),
}));

vi.mock('../src/lib/minio-client.js', () => ({
  getMinioBucket: mocks.getMinioBucket,
}));

import {
  archiveWorkdirToMinio,
  WORKDIR_ARCHIVE_BUCKET,
  workdirArchiveKey,
} from '../src/lib/workdir-archive.js';

// Workdir snapshots: cleanupWorkdir() uploads a tar.gz of the directory to
// the 'workdir-archives' MinIO bucket before removing it locally. The whole
// path is best-effort and silent — no console noise, never throws.

describe('workdirArchiveKey', () => {
  it('builds a <name>/<timestamp>.tar.gz key under its own folder', () => {
    const key = workdirArchiveKey('task-123', new Date('2026-07-26T05:00:00.000Z'));
    expect(key).toBe('task-123/2026-07-26T05-00-00-000Z.tar.gz');
  });

  it('sanitizes hostile directory names out of the key', () => {
    const key = workdirArchiveKey('../etc/passwd', new Date('2026-07-26T05:00:00.000Z'));
    expect(key.startsWith('..')).toBe(false);
    expect(key.split('/')[0]).not.toContain('..');
    expect(key.endsWith('.tar.gz')).toBe(true);
  });
});

describe('archiveWorkdirToMinio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when MinIO is not configured', async () => {
    mocks.getMinioBucket.mockResolvedValue(null);
    await expect(archiveWorkdirToMinio('/nonexistent-workdir')).resolves.toBeUndefined();
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('no-ops when the workdir does not exist', async () => {
    mocks.getMinioBucket.mockResolvedValue({ client: { putObject: mocks.putObject } });
    await archiveWorkdirToMinio('/nonexistent-workdir');
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('uploads a tar.gz containing the whole workdir', async () => {
    mocks.getMinioBucket.mockResolvedValue({ client: { putObject: mocks.putObject } });
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'archive-test-'));
    const workdir = path.join(tmp, 'task-1');
    try {
      await mkdir(path.join(workdir, 'src'), { recursive: true });
      await writeFile(path.join(workdir, 'src', 'a.ts'), 'export const a = 1;\n');
      await writeFile(path.join(workdir, 'README.md'), '# hello\n');

      await archiveWorkdirToMinio(workdir);

      expect(mocks.putObject).toHaveBeenCalledTimes(1);
      const [bucket, key, body] = mocks.putObject.mock.calls[0] as [string, string, Buffer];
      expect(bucket).toBe(WORKDIR_ARCHIVE_BUCKET);
      expect(key.startsWith('task-1/')).toBe(true);
      expect(key.endsWith('.tar.gz')).toBe(true);

      const tarFile = path.join(tmp, 'snapshot.tar.gz');
      await writeFile(tarFile, body);
      const { stdout } = await execFile('tar', ['-tzf', tarFile]);
      expect(stdout).toContain('task-1/src/a.ts');
      expect(stdout).toContain('task-1/README.md');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('never throws when the upload fails', async () => {
    const failing = { putObject: vi.fn().mockRejectedValue(new Error('minio down')) };
    mocks.getMinioBucket.mockResolvedValue({ client: failing });
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'archive-fail-'));
    const workdir = path.join(tmp, 'task-2');
    try {
      await mkdir(workdir, { recursive: true });
      await expect(archiveWorkdirToMinio(workdir)).resolves.toBeUndefined();
      // The workdir itself is untouched — removal stays cleanup's job.
      expect((await stat(workdir)).isDirectory()).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
