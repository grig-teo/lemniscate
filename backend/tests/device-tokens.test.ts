import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateDeviceToken,
  generatePairingCode,
  hashDeviceToken,
  PAIRING_CODE_ALPHABET,
} from '../src/lib/device-tokens.js';

// Locking tests for the device credential helpers: pairing codes must stay
// human-transcribable (unambiguous alphabet), device tokens must be long
// random hex, and only the sha256 hash is ever stored.

describe('generatePairingCode', () => {
  it('returns 6 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 100; i += 1) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[A-Z2-9]{6}$/);
      expect([...code].every((ch) => PAIRING_CODE_ALPHABET.includes(ch))).toBe(true);
    }
  });

  it('excludes ambiguous characters 0, O, 1, I from the alphabet', () => {
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[0O1I]/);
  });
});

describe('generateDeviceToken', () => {
  it('returns 48 lowercase hex chars', () => {
    expect(generateDeviceToken()).toMatch(/^[0-9a-f]{48}$/);
  });

  it('generates distinct tokens', () => {
    expect(generateDeviceToken()).not.toBe(generateDeviceToken());
  });
});

describe('hashDeviceToken', () => {
  it('returns the sha256 hex of the token', () => {
    const token = generateDeviceToken();
    expect(hashDeviceToken(token)).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
  });

  it('is deterministic and input-sensitive', () => {
    expect(hashDeviceToken('abc')).toBe(hashDeviceToken('abc'));
    expect(hashDeviceToken('abc')).not.toBe(hashDeviceToken('abd'));
  });
});
