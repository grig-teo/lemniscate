import { describe, expect, it } from 'vitest';
import { parseSkillSlugs } from '../src/lib/task-skills.js';

// Locking tests for the Task.skills / Repository.skillSlugs JSON parsing
// (stored as Json in the DB; anything malformed degrades to no skills).

describe('parseSkillSlugs', () => {
  it('returns a valid string array unchanged', () => {
    expect(parseSkillSlugs(['tdd', 'review'])).toEqual(['tdd', 'review']);
  });

  it('degrades null/undefined (unset) to an empty array', () => {
    expect(parseSkillSlugs(null)).toEqual([]);
    expect(parseSkillSlugs(undefined)).toEqual([]);
  });

  it('degrades malformed JSON values to an empty array', () => {
    expect(parseSkillSlugs('tdd')).toEqual([]);
    expect(parseSkillSlugs([1, 'tdd'])).toEqual([]);
    expect(parseSkillSlugs({ slugs: ['tdd'] })).toEqual([]);
  });
});
