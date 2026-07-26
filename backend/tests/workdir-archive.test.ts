import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const minio = vi.hoisted(() => ({
  putObject: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../src/lib/minio-client.js', () => ({
  getMinioClient: () => minio.getClient(),
  getMinioBucket: () => 'test-bucket',
}));

import {
  WORKDIR_ARCHIVE_BUCKET,
  archiveWorkdirToMinio,
  workdirArchiveKey,
} from '../src/lib/workdir-archive.js';

describe('workdirArchiveKey', () => {
  it('builds a dated tarball key under the archive folder', () => {
    const key = workdirArchiveKey('task-42', new Date('2024-01-02T03:04:05Z'));
    expect(key).toBe(`${WORKDIR_ARCHIVE_BUCKET}/task-42-20240102-030405.tar.gz`);
  });
});

describe('archiveWorkdirToMinio', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'workdir-archive-test-'));
    await writeFile(path.join(workdir, 'result.txt'), 'agent output');
    minio.putObject.mockReset().mockResolvedValue(undefined);
    minio.getClient.mockReset().mockReturnValue({ putObject: minio.putObject });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('uploads a tarball of the workdir into the archive folder', async () => {
    await archiveWorkdirToMinio(workdir);
    expect(minio.putObject).toHaveBeenCalledTimes(1);
    const [bucket, key, body] = minio.putObject.mock.calls[0]!;
    expect(bucket).toBe('test-bucket');
    expect(key).toMatch(new RegExp(`^${WORKDIR_ARCHIVE_BUCKET}/.+\\.tar\\.gz$`));
    expect(Buffer.isBuffer(body)).toBe(true);
    expect((body as Buffer).length).toBeGreaterThan(0);
  });

  it('leaves the workdir itself untouched — removal stays cleanup\'s job', async () => {
    await archiveWorkdirToMinio(workdir);
    const content = await readFile(path.join(workdir, 'result.txt'), 'utf8');
    expect(content).toBe('agent output');
  });

  it('is a no-op when MinIO is not configured', async () => {
    minio.getClient.mockReturnValue(null);
    await expect(archiveWorkdirToMinio(workdir)).resolves.toBeUndefined();
    expect(minio.putObject).not.toHaveBeenCalled();
  });

  it('never throws, even when the upload fails', async () => {
    minio.putObject.mockRejectedValue(new Error('minio down'));
    await expect(archiveWorkdirToMinio(workdir)).resolves.toBeUndefined();
  });
});
