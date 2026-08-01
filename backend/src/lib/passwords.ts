import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Password hashing for the internal gitlem host (gitlem accounts are the
// only password-authenticated identities — lemniscate itself is OAuth-only).
// scrypt from node:crypto: no native dependency, memory-hard enough for an
// internal tool. Stored format: `scrypt:N:r:p:<salt b64>:<hash b64>`.

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

// Bounds for params parsed out of a stored hash: anything outside them is
// a malformed row, and scryptSync would throw (turning login into a 500).
const MAX_SCRYPT_N = 1 << 20;
const MAX_SCRYPT_R = 32;
const MAX_SCRYPT_P = 16;
const MAX_KEY_LENGTH = 1024;

function isValidScryptParams(n: number, r: number, p: number): boolean {
  const validN = Number.isInteger(n) && n >= 2 && n <= MAX_SCRYPT_N && (n & (n - 1)) === 0;
  const validR = Number.isInteger(r) && r >= 1 && r <= MAX_SCRYPT_R;
  const validP = Number.isInteger(p) && p >= 1 && p <= MAX_SCRYPT_P;
  return validN && validR && validP;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const saltPart = parts[4];
  const hashPart = parts[5];
  if (!saltPart || !hashPart) return false;
  if (!isValidScryptParams(n, r, p)) return false;
  const salt = Buffer.from(saltPart, 'base64');
  const expected = Buffer.from(hashPart, 'base64');
  if (expected.length === 0 || expected.length > MAX_KEY_LENGTH) return false;
  try {
    const derived = scryptSync(password, salt, expected.length, { N: n, r, p });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

let cachedDummyHash: string | null = null;

/**
 * A real scrypt hash of a random non-password, so login can run a full
 * verification on unknown emails instead of skipping the scrypt work
 * (which would make account existence measurable via response time).
 */
export function dummyPasswordHash(): string {
  cachedDummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return cachedDummyHash;
}
