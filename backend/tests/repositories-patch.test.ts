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
    expect(buildPatchData({ autoCreatePr: true })).toEqual({ autoCreatePr: true });
  });

  it('passes skillSlugs through when sent', () => {
    expect(buildPatchData({ skillSlugs: ['tdd', 'review'] })).toEqual({
      skillSlugs: ['tdd', 'review'],
    });
  });

  it('passes agentsMdSkillId through, including an explicit null detach', () => {
    expect(buildPatchData({ agentsMdSkillId: 'skill-1' })).toEqual({ agentsMdSkillId: 'skill-1' });
    expect(buildPatchData({ agentsMdSkillId: null })).toEqual({ agentsMdSkillId: null });
  });

  it('omits skill fields when they were not sent', () => {
    expect(buildPatchData({ hidden: true })).toEqual({ hidden: true });
  });

  it('passes autoRunProposals through when sent', () => {
    expect(buildPatchData({ autoRunProposals: true })).toEqual({ autoRunProposals: true });
  });
});
