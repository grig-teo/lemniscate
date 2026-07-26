import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';

// checkArtifactQuota: per-device sliding 24h upload counter in Redis
// (INCR + EXPIRE on `artifact-quota:<deviceId>`). Beyond
// DEVICE_ARTIFACT_MAX_PER_DAY uploads in the window the upload is refused.
// A Redis outage fails OPEN (allow the upload) — availability of uploads
// beats quota strictness, mirroring the lifecycle best-effort policy.

const mocks = vi.hoisted(() => ({
  incr: vi.fn(),
  expire: vi.fn(),
}));

vi.mock('../src/lib/redis.js', () => ({
  getRedisClient: () => ({ incr: mocks.incr, expire: mocks.expire }),
}));

import { artifactQuotaKey, checkArtifactQuota } from '../src/lib/device-artifacts.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.incr.mockResolvedValue(1);
  mocks.expire.mockResolvedValue(1);
});

describe('checkArtifactQuota', () => {
  it('allows the upload under the daily limit and counts it per device', async () => {
    mocks.incr.mockResolvedValue(config.DEVICE_ARTIFACT_MAX_PER_DAY);
    await expect(checkArtifactQuota('dev-1')).resolves.toBe(true);
    expect(mocks.incr).toHaveBeenCalledWith(artifactQuotaKey('dev-1'));
  });

  it('refuses the upload beyond DEVICE_ARTIFACT_MAX_PER_DAY', async () => {
    mocks.incr.mockResolvedValue(config.DEVICE_ARTIFACT_MAX_PER_DAY + 1);
    await expect(checkArtifactQuota('dev-1')).resolves.toBe(false);
  });

  it('sets a 24h expiry only on the first upload of the window', async () => {
    await checkArtifactQuota('dev-1');
    expect(mocks.expire).toHaveBeenCalledWith(artifactQuotaKey('dev-1'), 24 * 60 * 60);

    vi.clearAllMocks();
    mocks.incr.mockResolvedValue(2);
    await checkArtifactQuota('dev-1');
    expect(mocks.expire).not.toHaveBeenCalled();
  });

  it('fails open when Redis is unavailable', async () => {
    mocks.incr.mockRejectedValue(new Error('connection refused'));
    await expect(checkArtifactQuota('dev-1')).resolves.toBe(true);
  });
});
