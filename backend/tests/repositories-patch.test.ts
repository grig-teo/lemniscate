import { describe, expect, it } from 'vitest';
import { buildPatchData } from '../src/routes/repositories.js';

// Locking tests for the PATCH /repositories body→update-data mapping.

describe('buildPatchData', () => {
  it('passes the hidden flag through when sent', () => {
    expect(buildPatchData({ hidden: true })).toEqual({ hidden: true });
    expect(buildPatchData({ hidden: false })).toEqual({ hidden: false });
  });

  it('omits hidden when it was not sent', () => {
    expect(buildPatchData({})).toEqual({});
    expect(buildPatchData({ autoPropose: true })).toEqual({ autoPropose: true });
  });
});
