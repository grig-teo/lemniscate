import { describe, expect, it } from 'vitest';
import { safeEqualSecret } from '../src/lib/secret-compare.js';

// Shared-secret guard comparison: must be constant-time (sha256-normalized
// timingSafeEqual) so route guards never leak the secret through timing —
// and must still behave like plain equality for the guard logic.

describe('safeEqualSecret', () => {
  it('accepts the exact configured secret', () => {
    expect(safeEqualSecret('secret-token', 'secret-token')).toBe(true);
  });

  it('rejects a wrong secret of the same length', () => {
    expect(safeEqualSecret('secret-tokem', 'secret-token')).toBe(false);
  });

  it('rejects a secret of a different length without throwing', () => {
    expect(safeEqualSecret('short', 'a-much-longer-configured-secret')).toBe(false);
    expect(safeEqualSecret('a-much-longer-presented-secret', 'short')).toBe(false);
  });

  it('rejects missing or non-string input and an empty configured secret', () => {
    expect(safeEqualSecret(undefined, 'secret-token')).toBe(false);
    expect(safeEqualSecret(['secret-token'], 'secret-token')).toBe(false);
    expect(safeEqualSecret('', '')).toBe(false);
  });
});
