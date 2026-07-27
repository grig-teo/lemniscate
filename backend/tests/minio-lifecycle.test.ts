import { describe, expect, it } from 'vitest';

// Pure builder for the MinIO bucket lifecycle rule applied to the
// 'device-artifacts' bucket and the 'lemniscate-workdir-archives' bucket:
// objects are transient (APKs / post-mortem workdir tarballs), so they expire
// after their per-bucket TTL (default 7 / 14 days).

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

  it('accepts a bucket-derived rule id so each bucket has a distinct, traceable rule', () => {
    const rule = lifecycleRuleFor(14, 'expire-lemniscate-workdir-archives');
    expect(rule.Rule[0]).toMatchObject({
      ID: 'expire-lemniscate-workdir-archives',
      Status: 'Enabled',
      Expiration: { Days: 14 },
    });
  });

  it('defaults the id to the device-artifacts name (established contract)', () => {
    expect(lifecycleRuleFor(7).Rule[0]?.ID).toBe('expire-device-artifacts');
  });
});