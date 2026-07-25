import type { Skill } from '@/lib/hooks';

export interface SkillCategoryGroup {
  category: string;
  skills: Skill[];
}

/** Group `kind='skill'` entries by category, groups sorted alphabetically. */
export function groupSkillsByCategory(skills: Skill[]): SkillCategoryGroup[] {
  const groups = new Map<string, Skill[]>();
  for (const skill of skills) {
    if (skill.kind !== 'skill') continue;
    const list = groups.get(skill.category) ?? [];
    list.push(skill);
    groups.set(skill.category, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => ({ category, skills: list }));
}

/** Checkbox toggle: append a missing slug, remove a present one. */
export function toggleSlug(slugs: string[], slug: string): string[] {
  return slugs.includes(slug) ? slugs.filter((s) => s !== slug) : [...slugs, slug];
}

/**
 * Only the owner may edit a library entry: global rows (userId null) are
 * read-only for everyone, and the current user must be known and match.
 */
export function canEditSkill(
  skill: { userId: string | null },
  currentUserId: string | undefined,
): boolean {
  return currentUserId !== undefined && skill.userId === currentUserId;
}

export interface SelectedChip {
  slug: string;
  label: string;
}

/**
 * Chips for the selected slugs, in selection order. The label resolves to the
 * skill name when the skill is in the (possibly search-filtered) list, and
 * falls back to the raw slug otherwise.
 */
export function filterSelectedChips(selectedSlugs: string[], skills: Skill[]): SelectedChip[] {
  const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));
  return selectedSlugs.map((slug) => ({ slug, label: bySlug.get(slug)?.name ?? slug }));
}
