import type { FastifyInstance } from 'fastify';
import { checkReadiness, type HealthDeps } from '../lib/health.js';
import { prisma } from '../lib/prisma.js';
import { getRedisClient } from '../lib/redis.js';

// Liveness vs readiness: /health only proves the process answers HTTP (kept
// cheap so it never flaps), while /health/ready proves the API can actually
// serve — Postgres accepts a query and Redis answers PING (each bounded by
// READINESS_TIMEOUT_MS). Readiness returns 503 with per-check results so
// compose healthchecks and external monitors reflect real dependency
// health; a 503 there means "stop routing traffic/jobs to me".

export type { HealthDeps };

function productionDeps(): HealthDeps {
  return {
    checkPostgres: () => prisma.$queryRaw`SELECT 1`,
    checkRedis: () => getRedisClient().ping(),
  };
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', async () => ({ ok: true }));
  app.get('/health/ready', async (_request, reply) => {
    const report = await checkReadiness(deps);
    const ok = report.postgres && report.redis;
    return reply.status(ok ? 200 : 503).send({ ok, ...report });
  });
}

export function registerProductionHealthRoutes(app: FastifyInstance): void {
  registerHealthRoutes(app, productionDeps());
}

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  registerProductionHealthRoutes(app);
}
