import { describe, expect, it } from 'vitest';
import { dummyPasswordHash, hashPassword, verifyPassword } from '../src/lib/passwords.js';

// Unit tests for the gitlem scrypt password hashing: round-trip, malformed
// stored hashes (must return false, never throw — a crafted/garbage row
// would otherwise turn login into a 500), and the dummy hash used to
// equalize timing on unknown-email logins.

describe('hashPassword/verifyPassword', () => {
  it('round-trips a password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('returns false instead of throwing for malformed stored hashes', () => {
    const cases = [
      'not-a-hash',
      '',
      'bcrypt:16384:8:1:c2FsdA==:aGFzaA==',
      'scrypt:16384:8:1::',
      'scrypt::8:1:c2FsdA==:aGFzaA==', // N not a number
      'scrypt:abc:8:1:c2FsdA==:aGFzaA==', // N not a number
      'scrypt:16383:8:1:c2FsdA==:aGFzaA==', // N not a power of two
      'scrypt:0:8:1:c2FsdA==:aGFzaA==', // N too small
      'scrypt:999999999:8:1:c2FsdA==:aGFzaA==', // N absurdly large
      'scrypt:16384:0:1:c2FsdA==:aGFzaA==', // r = 0
      'scrypt:16384:8:0:c2FsdA==:aGFzaA==', // p = 0
      'scrypt:16384:8:1:c2FsdA==:', // empty hash
    ];
    for (const stored of cases) {
      expect(verifyPassword('pw', stored), stored).toBe(false);
    }
  });

  it('still verifies hashes produced by hashPassword after validation', () => {
    const stored = hashPassword('pw');
    expect(stored.startsWith('scrypt:16384:8:1:')).toBe(true);
    expect(verifyPassword('pw', stored)).toBe(true);
  });
});

describe('dummyPasswordHash', () => {
  it('returns a stable, verifiable-format hash that matches no password', () => {
    const first = dummyPasswordHash();
    expect(dummyPasswordHash()).toBe(first);
    expect(first.startsWith('scrypt:')).toBe(true);
    expect(verifyPassword('anything', first)).toBe(false);
  });
});
