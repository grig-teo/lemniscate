import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { getRedisClient } from '../lib/redis.js';
import { errorMessage } from '../lib/utils.js';

// Liveness (/health) is a static "process is up" signal; readiness
// (/health/ready) performs dependency-cheap probes (SELECT 1, PING) and
// returns 503 with per-dependency detail so compose healthchecks and
// external uptime probes reflect real dependency health.

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

async function readinessPayload(): Promise<ReadinessPayload> {
  const [postgres, redis] = await Promise.all([
    probe(() => prisma.$queryRaw`SELECT 1`),
    probe(() => getRedisClient().ping()),
  ]);
  return { ok: postgres.ok && redis.ok, dependencies: { postgres, redis } };
}

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true }));

  app.get('/health/ready', async (_request, reply) => {
    const payload = await readinessPayload();
    return reply.status(payload.ok ? 200 : 503).send(payload);
  });
}
