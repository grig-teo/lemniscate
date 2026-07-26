// Shared MinIO client: lazy singleton + on-demand bucket creation. Buckets
// are named by the caller ('lemniscate-library', 'device-artifacts', …).
// Returns null when MinIO is not configured so callers can no-op (local dev).
//
// Lazy so importing this module (e.g. in unit tests) never touches env
// validation or the network.

import { Client } from 'minio';

let client: Client | null = null;
const readyBuckets = new Set<string>();

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

/**
 * Readiness probe for the configured library bucket. Rejects when MinIO is
 * unreachable or the bucket is missing, so a failed probeDependency marks
 * the check unhealthy. Callers must gate on minioConfigured() first.
 */
export async function assertLibraryBucket(): Promise<void> {
  const minio = await getMinioClient();
  if (!minio) throw new Error('minio is not configured');
  const { config } = await import('../config.js');
  if (!(await minio.bucketExists(config.MINIO_BUCKET))) {
    throw new Error(`minio bucket '${config.MINIO_BUCKET}' missing`);
  }
}

/** Configured client + ensured bucket, or null when MinIO env vars are unset. */
export async function getMinioBucket(bucket: string): Promise<{ client: Client } | null> {
  const minio = await getMinioClient();
  if (!minio) return null;
  if (!readyBuckets.has(bucket)) {
    if (!(await minio.bucketExists(bucket))) {
      await minio.makeBucket(bucket);
    }
    readyBuckets.add(bucket);
  }
  return { client: minio };
}
