import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import type { HealthDeps } from '../lib/health.js';
import { prisma } from '../lib/prisma.js';
import { errorMessage } from '../lib/utils.js';

// Liveness vs readiness: /health only proves the process answers HTTP (used
// by nothing dependency-sensitive, kept cheap so it never flaps), while
// /health/ready proves the API can actually serve — Postgres accepts a query
// and Redis answers PING. Readiness returns 503 with per-dependency detail
// (ok flag plus error message) so compose healthchecks and external uptime
// monitors reflect real dependency health; a 503 there means "stop routing
// traffic/jobs to me".

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

interface DependencyStatus {
  ok: boolean;
  error?: string;
}

interface ReadinessPayload {
  ok: boolean;
  dependencies: { postgres: DependencyStatus; redis: DependencyStatus };
}

async function probe(check: () => Promise<unknown>): Promise<DependencyStatus> {
  try {
    await check();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function readinessPayload(deps: HealthDeps): Promise<ReadinessPayload> {
  const [postgres, redisStatus] = await Promise.all([
    probe(deps.checkPostgres),
    probe(deps.checkRedis),
  ]);
  return {
    ok: postgres.ok && redisStatus.ok,
    dependencies: { postgres, redis: redisStatus },
  };
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', async () => ({ ok: true }));
  app.get('/health/ready', async (_request, reply) => {
    const payload = await readinessPayload(deps);
    return reply.status(payload.ok ? 200 : 503).send(payload);
  });
}

export function registerProductionHealthRoutes(app: FastifyInstance): void {
  registerHealthRoutes(app, productionDeps());
  app.addHook('onClose', async () => {
    await redis?.quit();
    redis = null;
  });
}

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  registerProductionHealthRoutes(app);
}
