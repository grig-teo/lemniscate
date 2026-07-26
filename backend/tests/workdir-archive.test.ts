import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const minio = vi.hoisted(() => ({
  getMinioBucket: vi.fn(),
  fPutObject: vi.fn(),
}));

vi.mock('../src/lib/minio-client.js', () => ({
  getMinioBucket: minio.getMinioBucket,
}));

import {
  archiveObjectKey,
  archiveWorkdirToMinio,
  WORKDIR_ARCHIVE_BUCKET,
} from '../src/lib/workdir-archive.js';

describe('archiveObjectKey', () => {
  it('builds a dated tar.gz key under workdirs/ from the workdir name', () => {
    const key = archiveObjectKey(
      '/tmp/lemniscate-repos/task-42',
      new Date('2025-01-02T03:04:05.006Z'),
    );
    expect(key).toBe('workdirs/task-42-2025-01-02T03-04-05-006Z.tar.gz');
  });
});

describe('archiveWorkdirToMinio', () => {
  let workdir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    minio.getMinioBucket.mockResolvedValue({ client: { fPutObject: minio.fPutObject } });
    minio.fPutObject.mockResolvedValue(undefined);
    workdir = await mkdtemp(join(tmpdir(), 'workdir-archive-test-'));
    await writeFile(join(workdir, 'hello.txt'), 'hello');
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('uploads a tarball of the workdir into the archive bucket', async () => {
    await archiveWorkdirToMinio(workdir);
    expect(minio.getMinioBucket).toHaveBeenCalledWith(WORKDIR_ARCHIVE_BUCKET);
    expect(minio.fPutObject).toHaveBeenCalledTimes(1);
    const [bucket, key, filePath] = minio.fPutObject.mock.calls[0]!;
    expect(bucket).toBe(WORKDIR_ARCHIVE_BUCKET);
    expect(key).toMatch(/^workdirs\/workdir-archive-test-.+\.tar\.gz$/);
    expect(filePath).toMatch(/\.tar\.gz$/);
  });

  it('leaves the workdir in place (archival only, no deletion)', async () => {
    await archiveWorkdirToMinio(workdir);
    await expect(stat(join(workdir, 'hello.txt'))).resolves.toBeTruthy();
  });

  it('is a no-op when MinIO is not configured', async () => {
    minio.getMinioBucket.mockResolvedValue(null);
    await archiveWorkdirToMinio(workdir);
    expect(minio.fPutObject).not.toHaveBeenCalled();
  });

  it('never rejects, even when the upload fails', async () => {
    minio.fPutObject.mockRejectedValue(new Error('minio down'));
    await expect(archiveWorkdirToMinio(workdir)).resolves.toBeUndefined();
  });

  it('never rejects for a missing workdir', async () => {
    await expect(
      archiveWorkdirToMinio(join(workdir, 'does-not-exist')),
    ).resolves.toBeUndefined();
    expect(minio.fPutObject).not.toHaveBeenCalled();
  });
});
