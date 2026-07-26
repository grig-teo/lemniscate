// Device artifact store: APKs built by builder devices are uploaded to the
// MinIO 'device-artifacts' bucket under <deviceId>/<uuid>-<name>.apk. Install
// targets download them THROUGH the backend (GET /api/devices/artifacts/*,
// device-token auth) — presigned MinIO URLs would point at the internal
// endpoint, unreachable from devices.

import { randomUUID } from 'node:crypto';
import { getMinioBucket } from './minio-client.js';

export const DEVICE_ARTIFACTS_BUCKET = 'device-artifacts';

/** Filesystem/hostile characters out, path traversal stripped to basename. */
export function safeArtifactFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return safe || 'app.apk';
}

/** Object key: scoped per device, unique per upload. */
export function artifactKeyFor(deviceId: string, filename: string, uniqueId: string): string {
  return `${deviceId}/${uniqueId}-${safeArtifactFilename(filename)}`;
}

/** Owning device id (the first key segment, matching artifactKeyFor); null when malformed. */
export function artifactOwnerDeviceId(key: string): string | null {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return null;
  return key.slice(0, slash);
}

/** Store one uploaded artifact; throws when MinIO is not configured. */
export async function storeDeviceArtifact(
  deviceId: string,
  filename: string,
  body: Buffer,
): Promise<{ key: string }> {
  const ctx = await getMinioBucket(DEVICE_ARTIFACTS_BUCKET);
  if (!ctx) throw new Error('MinIO is not configured');
  const key = artifactKeyFor(deviceId, filename, randomUUID());
  await ctx.client.putObject(DEVICE_ARTIFACTS_BUCKET, key, body, body.length, {
    'Content-Type': 'application/vnd.android.package-archive',
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
