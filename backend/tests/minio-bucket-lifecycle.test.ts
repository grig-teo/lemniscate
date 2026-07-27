import { beforeEach, describe, expect, it, vi } from 'vitest';

// getMinioBucket is the single home for bucket-creation AND bucket-expiry
// policy: it applies a lifecycle rule to every transient bucket
// (device-artifacts, lemniscate-workdir-archives) but never to the permanent
// library bucket. This locks that wiring so the workdir-archives bucket —
// which previously had no expiry rule and grew without bound — gets TTL'd
// the same way device-artifacts does.

const mocks = vi.hoisted(() => ({
  bucketExists: vi.fn(),
  makeBucket: vi.fn(),
  setBucketLifecycle: vi.fn(),
}));

vi.mock('minio', () => ({
  Client: class {
    bucketExists = mocks.bucketExists;
    makeBucket = mocks.makeBucket;
    setBucketLifecycle = mocks.setBucketLifecycle;
  },
}));

const WORKDIR_BUCKET = 'lemniscate-workdir-archives';

vi.mock('../src/config.js', () => ({
  config: {
    MINIO_ENDPOINT: 'minio',
    MINIO_PORT: 9000,
    MINIO_ROOT_USER: 'user',
    MINIO_ROOT_PASSWORD: 'pass',
    MINIO_BUCKET: 'lemniscate-library',
    DEVICE_ARTIFACT_TTL_DAYS: 7,
    WORKDIR_ARCHIVE_BUCKET: WORKDIR_BUCKET,
    WORKDIR_ARCHIVE_TTL_DAYS: 14,
  },
}));

beforeEach(async () => {
  // Fresh module registry each test so the module-level readyBuckets cache
  // (and the lazy client singleton) reset — otherwise the second call for a
  // bucket would skip ensure+empty-lifecycle entirely.
  vi.resetModules();
  vi.clearAllMocks();
  mocks.bucketExists.mockResolvedValue(true);
  mocks.makeBucket.mockResolvedValue(undefined);
  mocks.setBucketLifecycle.mockResolvedValue(undefined);
});

async function importGetMinioBucket() {
  const mod = await import('../src/lib/minio-client.js');
  return mod.getMinioBucket;
}

describe('getMinioBucket lifecycle wiring', () => {
  it('applies the TTL lifecycle rule to the workdir-archives bucket on init', async () => {
    const getMinioBucket = await importGetMinioBucket();
    await getMinioBucket(WORKDIR_BUCKET);
    expect(mocks.setBucketLifecycle).toHaveBeenCalledTimes(1);
    const [bucket, rule] = mocks.setBucketLifecycle.mock.calls[0]!;
    expect(bucket).toBe(WORKDIR_BUCKET);
    expect(rule).toMatchObject({
      Rule: [
        {
          ID: 'expire-lemniscate-workdir-archives',
          Status: 'Enabled',
          Expiration: { Days: 14 },
        },
      ],
    });
  });

  it('applies the TTL lifecycle rule to the device-artifacts bucket on init', async () => {
    const getMinioBucket = await importGetMinioBucket();
    const { DEVICE_ARTIFACTS_BUCKET } = await import('../src/lib/minio-client.js');
    await getMinioBucket(DEVICE_ARTIFACTS_BUCKET);
    expect(mocks.setBucketLifecycle).toHaveBeenCalledTimes(1);
    const [bucket, rule] = mocks.setBucketLifecycle.mock.calls[0]!;
    expect(bucket).toBe(DEVICE_ARTIFACTS_BUCKET);
    expect(rule.Rule[0]).toMatchObject({
      ID: 'expire-device-artifacts',
      Expiration: { Days: 7 },
    });
  });

  it('does NOT apply an expiry rule to the permanent library bucket', async () => {
    const getMinioBucket = await importGetMinioBucket();
    await getMinioBucket('lemniscate-library');
    expect(mocks.setBucketLifecycle).not.toHaveBeenCalled();
  });

  it('still returns a client for every bucket regardless of TTL', async () => {
    const getMinioBucket = await importGetMinioBucket();
    await expect(getMinioBucket('lemniscate-library')).resolves.toMatchObject({
      client: expect.anything(),
    });
  });
});