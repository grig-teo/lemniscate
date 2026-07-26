import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { checkReadiness, type HealthDeps } from '../lib/health.js';
import { prisma } from '../lib/prisma.js';

// Liveness vs readiness: /health only proves the process answers HTTP (used
// by nothing dependency-sensitive, kept cheap so it never flaps), while
// /health/ready proves the API can actually serve — Postgres accepts a query
// and Redis answers PING. Compose healthchecks and uptime monitors hit
// /health/ready; a 503 there means "stop routing traffic/jobs to me".

let redis: Redis | null = null;

// Lazy singleton so importing this module (tests, worker) never opens a
// connection; only the first readiness probe does.
function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.REDIS_URL, { lazyConnect: false });
  }
  return redis;
}

function productionDeps(): HealthDeps {
  return {
    checkPostgres: () => prisma.$queryRaw`SELECT 1`,
    checkRedis: () => getRedis().ping(),
  };
}

export type { HealthDeps };

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
  app.addHook('onClose', async () => {
    await redis?.quit();
    redis = null;
  });
}
