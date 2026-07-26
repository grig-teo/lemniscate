// Shared MinIO client: lazy singleton + on-demand bucket creation. Buckets
// are named by the caller ('lemniscate-library', 'device-artifacts', …).
// Returns null when MinIO is not configured so callers can no-op (local dev).
//
// Lazy so importing this module (e.g. in unit tests) never touches env
// validation or the network.

import { Client } from 'minio';
import type { LifecycleConfig } from 'minio';

export const DEVICE_ARTIFACTS_BUCKET = 'device-artifacts';

let client: Client | null = null;
const readyBuckets = new Set<string>();

/** Lifecycle rule expiring every object in the bucket after `ttlDays` days. */
export function lifecycleRuleFor(ttlDays: number): LifecycleConfig {
  return {
    Rule: [
      {
        ID: 'expire-device-artifacts',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        Expiration: { Days: ttlDays },
      },
    ],
  };
}

// Best-effort: a lifecycle failure must not block uploads (availability of
// the artifact store beats policy strictness), so log and continue.
async function applyArtifactLifecycle(minio: Client, bucket: string): Promise<void> {
  const { config } = await import('../config.js');
  try {
    await minio.setBucketLifecycle(bucket, lifecycleRuleFor(config.DEVICE_ARTIFACT_TTL_DAYS));
  } catch (err) {
    console.warn(`minio: failed to apply lifecycle on bucket ${bucket}`, err);
  }
}

/** Configured client, or null when MinIO env vars are unset. No bucket creation. */
export async function getMinioClient(): Promise<Client | null> {
  const { config } = await import('../config.js');
  if (!config.MINIO_ENDPOINT || !config.MINIO_ROOT_USER || !config.MINIO_ROOT_PASSWORD) {
    return null;
  }
  if (client === null) {
    client = new Client({
      endPoint: config.MINIO_ENDPOINT,
      port: config.MINIO_PORT,
      useSSL: false,
      accessKey: config.MINIO_ROOT_USER,
      secretKey: config.MINIO_ROOT_PASSWORD,
    });
  }
  return client;
}

/** True when MinIO env vars are set, without touching the network. */
export async function minioConfigured(): Promise<boolean> {
  return (await getMinioClient()) !== null;
}

/** Create the bucket when missing; rejects when MinIO is unreachable. */
async function ensureBucket(minio: Client, bucket: string): Promise<void> {
  if (!(await minio.bucketExists(bucket))) {
    await minio.makeBucket(bucket);
  }
}

/**
 * Readiness probe for the configured library bucket. Ensures the bucket
 * rather than merely asserting it: nothing else creates MINIO_BUCKET at
 * startup (getMinioBucket creates it lazily on first library use), so a pure
 * existence check would 503 /health/ready forever on a fresh deployment and
 * wedge every depends_on: service_healthy consumer. Still hits MinIO on
 * every call, so an unreachable server keeps failing readiness. Callers must
 * gate on minioConfigured() first.
 */
export async function ensureLibraryBucket(): Promise<void> {
  const minio = await getMinioClient();
  if (!minio) throw new Error('minio is not configured');
  const { config } = await import('../config.js');
  await ensureBucket(minio, config.MINIO_BUCKET);
}

/** Configured client + ensured bucket, or null when MinIO env vars are unset. */
export async function getMinioBucket(bucket: string): Promise<{ client: Client } | null> {
  const minio = await getMinioClient();
  if (!minio) return null;
  if (!readyBuckets.has(bucket)) {
    await ensureBucket(minio, bucket);
    if (bucket === DEVICE_ARTIFACTS_BUCKET) {
      await applyArtifactLifecycle(minio, bucket);
    }
    readyBuckets.add(bucket);
  }
  return { client: minio };
}
