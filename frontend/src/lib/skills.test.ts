import { describe, expect, it } from 'vitest';

import { filterSelectedChips, groupSkillsByCategory, toggleSlug } from '@/lib/skills';
import type { Skill } from '@/lib/hooks';

function makeSkill(slug: string, category: string, kind: Skill['kind'] = 'skill'): Skill {
  return {
    id: `id-${slug}`,
    slug,
    name: `Name ${slug}`,
    category,
    description: `Description ${slug}`,
    tags: [],
    kind,
  };
}

describe('groupSkillsByCategory', () => {
  it('groups skills by category preserving in-category order', () => {
    const groups = groupSkillsByCategory([
      makeSkill('a', 'web-dev'),
      makeSkill('b', 'android'),
      makeSkill('c', 'web-dev'),
    ]);
    const webDev = groups.find((g) => g.category === 'web-dev');
    expect(webDev?.skills.map((s) => s.slug)).toEqual(['a', 'c']);
  });

  it('sorts groups alphabetically by category name', () => {
    const groups = groupSkillsByCategory([
      makeSkill('a', 'web-dev'),
      makeSkill('b', 'android'),
      makeSkill('c', 'ios'),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['android', 'ios', 'web-dev']);
  });

  it('excludes agents_md entries', () => {
    const groups = groupSkillsByCategory([
      makeSkill('a', 'web-dev'),
      makeSkill('agents-default', 'agents-md', 'agents_md'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.category).toBe('web-dev');
  });

  it('returns an empty list for no skills', () => {
    expect(groupSkillsByCategory([])).toEqual([]);
  });
});

describe('toggleSlug', () => {
  it('appends a missing slug', () => {
    expect(toggleSlug(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('removes a present slug', () => {
    expect(toggleSlug(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('does not mutate the input array', () => {
    const input = ['a'];
    toggleSlug(input, 'b');
    expect(input).toEqual(['a']);
  });
});

describe('filterSelectedChips', () => {
  it('resolves chip labels from the skill list, preserving selection order', () => {
    const chips = filterSelectedChips(
      ['b', 'a'],
      [makeSkill('a', 'web-dev'), makeSkill('b', 'android')],
    );
    expect(chips).toEqual([
      { slug: 'b', label: 'Name b' },
      { slug: 'a', label: 'Name a' },
    ]);
  });

  it('falls back to the slug when the skill is not in the (filtered) list', () => {
    const chips = filterSelectedChips(['missing'], [makeSkill('a', 'web-dev')]);
    expect(chips).toEqual([{ slug: 'missing', label: 'missing' }]);
  });

  it('returns an empty list when nothing is selected', () => {
    expect(filterSelectedChips([], [makeSkill('a', 'web-dev')])).toEqual([]);
  });
});
