// Device artifact store: APKs built by builder devices are uploaded to the
// MinIO 'device-artifacts' bucket under <deviceId>/<uuid>-<name>.apk. Install
// targets download them THROUGH the backend (GET /api/devices/artifacts/*,
// device-token auth) — presigned MinIO URLs would point at the internal
// endpoint, unreachable from devices.

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { DEVICE_ARTIFACTS_BUCKET, getMinioBucket } from './minio-client.js';
import { getRedisClient } from './redis.js';

// Bucket name lives in minio-client.ts (the bucket-ensuring module); this
// re-export keeps a single import site for artifact-store consumers.
export { DEVICE_ARTIFACTS_BUCKET } from './minio-client.js';

/** Filesystem/hostile characters out, path traversal stripped to basename. */
export function safeArtifactFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return safe || 'artifact.bin';
}

const APK_MIME = 'application/vnd.android.package-archive';
const LOG_MIME = 'text/plain; charset=utf-8';
const DEFAULT_MIME = 'application/octet-stream';

/**
 * Content-Type for an artifact key/filename, inferred from its extension.
 * `.apk` → APK mime, `.log` → text/plain, everything else → octet-stream.
 */
export function contentTypeForFilename(filename: string): string {
  if (filename.endsWith('.apk')) return APK_MIME;
  if (filename.endsWith('.log')) return LOG_MIME;
  return DEFAULT_MIME;
}

/** Object key: scoped per device, unique per upload. */
export function artifactKeyFor(deviceId: string, filename: string, uniqueId: string): string {
  return `${deviceId}/${uniqueId}-${safeArtifactFilename(filename)}`;
}

const ARTIFACT_QUOTA_WINDOW_SECONDS = 24 * 60 * 60;

/** Redis key for the device's rolling 24h upload counter. */
export function artifactQuotaKey(deviceId: string): string {
  return `artifact-quota:${deviceId}`;
}

/** Whether the `count`-th upload in the window is still within the daily cap. */
export function artifactQuotaAllowed(count: number, maxPerDay: number): boolean {
  return count <= maxPerDay;
}

// Sliding daily cap: INCR the per-device counter, starting the 24h window on
// the first upload. Fails OPEN on Redis outage — availability of uploads
// beats quota strictness (same trade-off as the best-effort lifecycle rule).
export async function checkArtifactQuota(deviceId: string): Promise<boolean> {
  const redis = getRedisClient();
  const key = artifactQuotaKey(deviceId);
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ARTIFACT_QUOTA_WINDOW_SECONDS);
    return artifactQuotaAllowed(count, config.DEVICE_ARTIFACT_MAX_PER_DAY);
  } catch {
    return true;
  }
}

/** Owning device id (the first key segment, matching artifactKeyFor); null when malformed. */
export function artifactOwnerDeviceId(key: string): string | null {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return null;
  return key.slice(0, slash);
}

/**
 * Store one uploaded artifact; throws when MinIO is not configured.
 * The content type defaults to the APK mime for backward compatibility;
 * callers uploading other artifact types (logs) should pass it explicitly.
 */
export async function storeDeviceArtifact(
  deviceId: string,
  filename: string,
  body: Buffer,
  contentType: string = APK_MIME,
): Promise<{ key: string }> {
  const ctx = await getMinioBucket(DEVICE_ARTIFACTS_BUCKET);
  if (!ctx) throw new Error('MinIO is not configured');
  const key = artifactKeyFor(deviceId, filename, randomUUID());
  await ctx.client.putObject(DEVICE_ARTIFACTS_BUCKET, key, body, body.length, {
    'Content-Type': contentType,
  });
  return { key };
}

/** Backend-relative download path for a stored artifact (device-token auth). */
export function artifactDownloadPath(key: string): string {
  return `/api/devices/artifacts/${key}`;
}

/** Stream one stored artifact; null when MinIO is down or the key is missing. */
export async function deviceArtifactStream(key: string) {
  const ctx = await getMinioBucket(DEVICE_ARTIFACTS_BUCKET);
  if (!ctx) return null;
  try {
    const stat = await ctx.client.statObject(DEVICE_ARTIFACTS_BUCKET, key);
    const stream = await ctx.client.getObject(DEVICE_ARTIFACTS_BUCKET, key);
    return { stream, size: stat.size };
  } catch {
    return null;
  }
}
