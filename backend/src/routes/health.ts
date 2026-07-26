import type { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';

const PROBE_TIMEOUT_MS = 2000;

export interface HealthDeps {
  checkPostgres: () => Promise<unknown>;
  checkRedis: () => Promise<unknown>;
}

let redisClient: Redis | null = null;

function getRedisClient(): Redis {
  if (redisClient) return redisClient;
  redisClient = new Redis(config.redisUrl, {
    // Probe-only client: fail fast instead of retrying/queueing pings during
    // an outage, so a down Redis surfaces as a quick 503 rather than a burst
    // of queued commands when it recovers.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  // ioredis emits 'error' on connection failure and Node throws on an
  // 'error' event with no listener — exactly the outage this endpoint exists
  // to report. Swallow it here; the probe reports redis:false instead.
  redisClient.on('error', () => {});
  return redisClient;
}

async function probeWithTimeout(check: () => Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('health probe timed out')), PROBE_TIMEOUT_MS);
    });
    await Promise.race([check(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultDeps(): HealthDeps {
  return {
    checkPostgres: () => prisma.$queryRaw`SELECT 1`,
    checkRedis: async () => {
      await getRedisClient().ping();
    },
  };
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps = defaultDeps()): void {
  // Liveness: cheap and dependency-free so it never flaps on a DB blip.
  app.get('/health', async () => ({ ok: true }));

  // Readiness: 503 when any dependency check fails or times out.
  app.get('/health/ready', async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      probeWithTimeout(deps.checkPostgres),
      probeWithTimeout(deps.checkRedis),
    ]);
    const ok = postgres && redis;
    return reply.status(ok ? 200 : 503).send({ ok, postgres, redis });
  });
}
