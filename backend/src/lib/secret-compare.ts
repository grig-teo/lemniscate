import { createHash, timingSafeEqual } from 'node:crypto';

// Constant-time comparison of shared secrets (metrics token, Traefik provider
// token). Both sides are sha256-hashed first so the compared buffers are
// always equal length — timingSafeEqual throws on a length mismatch, and an
// early length check would itself leak the secret's length through timing.
// Single home for this rule (AGENTS.md §6): route guards must not compare
// secrets with !==.
export function safeEqualSecret(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || expected === '') return false;
  const presentedHash = createHash('sha256').update(presented).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}
