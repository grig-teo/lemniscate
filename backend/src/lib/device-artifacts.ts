// Device artifact store: APKs built by builder devices are uploaded to the
// MinIO 'device-artifacts' bucket under <deviceId>/<uuid>-<name>.apk and
// handed to install targets as 24h presigned GET URLs (generated fresh at
// dispatch time so they never expire mid-queue).

import { randomUUID } from 'node:crypto';
import { getMinioBucket } from './minio-client.js';

export const DEVICE_ARTIFACTS_BUCKET = 'device-artifacts';
export const PRESIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

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

/** Fresh 24h GET URL for a stored artifact; throws when MinIO is not configured. */
export async function presignedArtifactUrl(key: string): Promise<string> {
  const ctx = await getMinioBucket(DEVICE_ARTIFACTS_BUCKET);
  if (!ctx) throw new Error('MinIO is not configured');
  return ctx.client.presignedGetObject(DEVICE_ARTIFACTS_BUCKET, key, PRESIGNED_URL_TTL_SECONDS);
}
