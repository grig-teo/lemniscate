import { createHash, timingSafeEqual } from 'node:crypto';

// Constant-time comparison of shared secrets (metrics token, Traefik provider
// token, GitLab webhook token). Both sides are sha256-hashed first so the
// compared buffers are always equal length — timingSafeEqual throws on a
// length mismatch, and an early length check would itself leak the secret's
// length through timing.
// Single home for this rule (AGENTS.md §6): route guards must not compare
// secrets with !==.
export function safeEqualSecret(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || expected === '') return false;
  const presentedHash = createHash('sha256').update(presented).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}

// Constant-time comparison of hex-encoded HMAC signatures (GitHub
// X-Hub-Signature-256). Unlike safeEqualSecret, the expected value is a
// pre-computed HMAC digest (always 64 hex chars for SHA-256) — we cannot
// hash-then-compare because that would destroy the signature. Instead both
// sides are parsed as hex Buffers of known equal length and compared
// byte-for-byte. A length mismatch rejects early: the expected HMAC length
// (32 bytes) is public knowledge, so this leaks nothing.
export function safeEqualHexSignature(presented: string, expected: string): boolean {
  if (expected === '' || presented.length !== expected.length) return false;
  const presentedBuf = Buffer.from(presented, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
}
