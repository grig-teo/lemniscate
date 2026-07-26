import type { FastifyInstance } from 'fastify';
import { checkReadiness, type HealthDeps } from '../lib/health.js';
import { assertLibraryBucket, minioConfigured } from '../lib/minio-client.js';
import { prisma } from '../lib/prisma.js';
import { getRedisClient } from '../lib/redis.js';

// Liveness vs readiness: /health only proves the process answers HTTP (kept
// cheap so it never flaps), while /health/ready proves the API can actually
// serve — Postgres accepts a query, Redis answers PING, and (when MinIO is
// configured) the library bucket exists — each bounded by
// READINESS_TIMEOUT_MS. Readiness returns 503 with per-check results so
// compose healthchecks and external monitors reflect real dependency
// health; a 503 there means "stop routing traffic/jobs to me".

export type { HealthDeps };

async function productionDeps(): Promise<HealthDeps> {
  const deps: HealthDeps = {
    checkPostgres: () => prisma.$queryRaw`SELECT 1`,
    checkRedis: () => getRedisClient().ping(),
  };
  // MinIO is optional (local dev runs without it); only probe it when the
  // operator configured it, otherwise it would 503 every readiness check.
  if (await minioConfigured()) {
    deps.checkMinio = () => assertLibraryBucket();
  }
  return deps;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', async () => ({ ok: true }));
  app.get('/health/ready', async (_request, reply) => {
    const report = await checkReadiness(deps);
    const ok = report.postgres && report.redis && report.minio !== false;
    return reply.status(ok ? 200 : 503).send({ ok, ...report });
  });
}

export async function registerProductionHealthRoutes(app: FastifyInstance): Promise<void> {
  registerHealthRoutes(app, await productionDeps());
}

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  await registerProductionHealthRoutes(app);
}
