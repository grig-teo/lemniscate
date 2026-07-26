import { beforeEach, describe, expect, it, vi } from 'vitest';

// The MinIO readiness probe must ENSURE the library bucket, not merely
// assert it: the bucket is otherwise created lazily on first library use, so
// on a fresh deployment a pure bucketExists assertion would 503
// /health/ready forever and wedge every depends_on: service_healthy
// consumer (frontend, traefik). The probe still hits MinIO on every call so
// an unreachable server keeps failing readiness.

const mocks = vi.hoisted(() => ({ bucketExists: vi.fn(), makeBucket: vi.fn() }));
const { bucketExists, makeBucket } = mocks;

vi.mock('minio', () => ({
  Client: class {
    bucketExists = mocks.bucketExists;
    makeBucket = mocks.makeBucket;
    setBucketLifecycle = vi.fn();
  },
}));

vi.mock('../src/config.js', () => ({
  config: {
    MINIO_ENDPOINT: 'minio',
    MINIO_PORT: 9000,
    MINIO_ROOT_USER: 'user',
    MINIO_ROOT_PASSWORD: 'pass',
    MINIO_BUCKET: 'lemniscate-library',
    DEVICE_ARTIFACT_TTL_DAYS: 7,
  },
}));

import { ensureLibraryBucket } from '../src/lib/minio-client.js';

describe('ensureLibraryBucket (MinIO readiness probe)', () => {
  beforeEach(() => {
    bucketExists.mockReset();
    makeBucket.mockReset();
  });

  it('resolves without creating when the configured bucket exists', async () => {
    bucketExists.mockResolvedValue(true);
    await expect(ensureLibraryBucket()).resolves.toBeUndefined();
    expect(makeBucket).not.toHaveBeenCalled();
  });

  it('creates the bucket on demand so a fresh deployment becomes healthy', async () => {
    bucketExists.mockResolvedValue(false);
    makeBucket.mockResolvedValue(undefined);
    await expect(ensureLibraryBucket()).resolves.toBeUndefined();
    expect(makeBucket).toHaveBeenCalledWith('lemniscate-library');
  });

  it('rejects when MinIO is unreachable so readiness 503s', async () => {
    bucketExists.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(ensureLibraryBucket()).rejects.toThrow('ECONNREFUSED');
  });
});
