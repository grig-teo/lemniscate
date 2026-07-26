// Dependency-aware readiness probing, shared by the API's /health/ready
// route, the worker's health server, and unit tests. Kept free of
// Fastify/Prisma/ioredis imports so the probe logic is exercised against
// injected checks, not mocks of modules.

export interface HealthDeps {
  checkPostgres: () => Promise<unknown>;
  checkRedis: () => Promise<unknown>;
  // Optional: only supplied when MinIO is configured. Must reject (not
  // resolve false) when the bucket is unreachable or missing.
  checkMinio?: () => Promise<unknown>;
}

export interface ReadinessReport {
  postgres: boolean;
  redis: boolean;
  // Tri-state: null when MinIO is not configured (excluded from readiness).
  minio: boolean | null;
}

// Long enough to ride out a transient blip, short enough that a compose
// healthcheck (timeout 5s) still sees a definitive answer.
export const READINESS_TIMEOUT_MS = 2000;

// A check is healthy only if it resolves in time; any throw or hang is a
// failed check, never a thrown error from the readiness probe itself.
export async function probeDependency(
  check: () => Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('health check timed out')), timeoutMs);
  });
  try {
    await Promise.race([check(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeOptional(
  check: (() => Promise<unknown>) | undefined,
  timeoutMs: number,
): Promise<boolean | null> {
  if (!check) return null;
  return probeDependency(check, timeoutMs);
}

export async function checkReadiness(
  deps: HealthDeps,
  timeoutMs: number = READINESS_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const [postgres, redis, minio] = await Promise.all([
    probeDependency(deps.checkPostgres, timeoutMs),
    probeDependency(deps.checkRedis, timeoutMs),
    probeOptional(deps.checkMinio, timeoutMs),
  ]);
  return { postgres, redis, minio };
}
