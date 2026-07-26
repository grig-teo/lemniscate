import { describe, expect, it } from 'vitest';

// Pure builder for the MinIO bucket lifecycle rule applied to the
// 'device-artifacts' bucket: APKs are transient build outputs, so objects
// expire DEVICE_ARTIFACT_TTL_DAYS (default 7) days after upload.

import { lifecycleRuleFor } from '../src/lib/minio-client.js';

describe('lifecycleRuleFor', () => {
  it('builds a single enabled expiration rule for the given TTL in days', () => {
    const config = lifecycleRuleFor(7);
    expect(config.Rule).toHaveLength(1);
    expect(config.Rule[0]).toMatchObject({
      ID: 'expire-device-artifacts',
      Status: 'Enabled',
      Expiration: { Days: 7 },
    });
  });

  it('applies to the whole bucket (empty prefix filter)', () => {
    const config = lifecycleRuleFor(7);
    expect(config.Rule[0]?.Filter).toEqual({ Prefix: '' });
  });

  it('reflects a non-default TTL', () => {
    expect(lifecycleRuleFor(30).Rule[0]?.Expiration).toEqual({ Days: 30 });
  });
});
