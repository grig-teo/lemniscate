// Cross-run memory of rate-limited LLM configs ("token limit reached → move
// to another model").
//
// When a config's provider reports its quota/rate limit exhausted, the
// failover chain (llm-failover.ts) already promotes the user's next enabled
// config for the rest of the run. Without cross-run memory the NEXT run
// would resolve the same exhausted default again, burn its configured
// retries against the still-limited endpoint, and only then fail over. This
// module parks such a config in Redis with a cooldown:
//
//   - markConfigExhausted stores llm-exhausted:<configId> = {until, reason}
//     with a PX TTL equal to the cooldown. The cooldown honors the
//     provider's own reset time when parseable (rateLimitDeferMs), else the
//     LLM_EXHAUSTION_COOLDOWN_MS config value.
//   - findLlmConfig (llm-config-resolution.ts) and findFailoverConfigs
//     (llm-failover.ts) skip parked configs, so the promoted model
//     effectively becomes the default while the primary is limited.
//   - TTL expiry IS the automatic recovery: once the limit window resets,
//     the record disappears and the previous default is preferred again —
//     no probe job, no manual switching.
//
// Everything here is advisory: a Redis outage degrades to the pre-existing
// in-run failover behavior and must never break an LLM call.

import { config } from '../config.js';
import { isRateLimited, rateLimitDeferMs } from './llm-rate-limit.js';
import { getRedisClient } from './redis.js';

export interface LlmExhaustion {
  /** ISO timestamp after which the config becomes preferred again. */
  until: string;
  /** Why the config was parked (truncated provider error message). */
  reason: string;
}

const KEY_PREFIX = 'llm-exhausted:';
const REASON_MAX_CHARS = 200;

// Cooldown for parking a config after this error, or null when the error is
// not a rate-limit/quota signal — only quota signals may park a config, so
// a malformed-request bug never triggers pointless model switching.
export function exhaustionCooldownMs(err: unknown, now = Date.now()): number | null {
  if (!isRateLimited(err)) return null;
  return rateLimitDeferMs(err, now, config.LLM_EXHAUSTION_COOLDOWN_MS);
}

// Parks a config until now + cooldownMs. Returns the stored record so the
// caller can surface the recovery time; null when storage failed.
export async function markConfigExhausted(
  configId: string,
  cooldownMs: number,
  reason: string,
): Promise<LlmExhaustion | null> {
  const record: LlmExhaustion = {
    until: new Date(Date.now() + cooldownMs).toISOString(),
    reason: reason.slice(0, REASON_MAX_CHARS),
  };
  try {
    await getRedisClient().set(
      `${KEY_PREFIX}${configId}`,
      JSON.stringify(record),
      'PX',
      Math.max(1, Math.round(cooldownMs)),
    );
    return record;
  } catch {
    return null;
  }
}

function parseExhaustion(raw: string | null): LlmExhaustion | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LlmExhaustion;
    if (typeof parsed?.until !== 'string' || typeof parsed?.reason !== 'string') return null;
    return { until: parsed.until, reason: parsed.reason };
  } catch {
    return null;
  }
}

/** The live exhaustion record for a config; null when healthy/expired/down. */
export async function readConfigExhaustion(configId: string): Promise<LlmExhaustion | null> {
  try {
    return parseExhaustion(await getRedisClient().get(`${KEY_PREFIX}${configId}`));
  } catch {
    return null;
  }
}

// The subset of configs not currently parked, order preserved. Redis down
// treats everything as healthy — the in-run failover chain then absorbs a
// still-limited endpoint exactly as before this registry existed.
export async function filterHealthyConfigs<T extends { id: string }>(configs: T[]): Promise<T[]> {
  if (configs.length === 0) return configs;
  try {
    const raws = await getRedisClient().mget(...configs.map((c) => `${KEY_PREFIX}${c.id}`));
    return configs.filter((_, i) => parseExhaustion(raws[i] ?? null) === null);
  } catch {
    return configs;
  }
}
