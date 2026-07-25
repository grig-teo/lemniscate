// Shared MinIO client: lazy singleton + on-demand bucket creation. Buckets
// are named by the caller ('lemniscate-library', 'device-artifacts', …).
// Returns null when MinIO is not configured so callers can no-op (local dev).
//
// Lazy so importing this module (e.g. in unit tests) never touches env
// validation or the network.

import { Client } from 'minio';

let client: Client | null = null;
const readyBuckets = new Set<string>();

/** Configured client + ensured bucket, or null when MinIO env vars are unset. */
export async function getMinioBucket(bucket: string): Promise<{ client: Client } | null> {
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
  if (!readyBuckets.has(bucket)) {
    if (!(await client.bucketExists(bucket))) {
      await client.makeBucket(bucket);
    }
    readyBuckets.add(bucket);
  }
  return { client };
}
