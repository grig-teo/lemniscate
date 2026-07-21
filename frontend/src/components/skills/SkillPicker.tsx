import { ChevronDown, ChevronRight, X } from 'lucide-react';

import type { Skill } from '@/lib/hooks';
import { filterSelectedChips, groupSkillsByCategory } from '@/lib/skills';
import { Badge } from '@/components/ui/badge';

/**
 * Shared skills-picker building blocks used by both the repository-level
 * SkillsDialog and the compact picker inside the create-repository dialog.
 */

export function SelectedChips({
  selectedSlugs,
  skills,
  onRemove,
}: {
  selectedSlugs: string[];
  skills: Skill[];
  onRemove: (slug: string) => void;
}) {
  const chips = filterSelectedChips(selectedSlugs, skills);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Selected skills">
      {chips.map((chip) => (
        <Badge key={chip.slug} variant="secondary" className="gap-1 pr-1">
          <span className="max-w-40 truncate">{chip.label}</span>
          <button
            type="button"
            aria-label={`Remove ${chip.label}`}
            onClick={() => onRemove(chip.slug)}
            className="rounded-full p-0.5 hover:bg-background/60"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </Badge>
      ))}
    </div>
  );
}

function SkillRow({
  skill,
  checked,
  onToggle,
}: {
  skill: Skill;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{skill.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{skill.description}</span>
        <span className="block truncate text-xs text-muted-foreground/70">{skill.slug}</span>
      </span>
    </label>
  );
}

function SkillCategoryGroup({
  category,
  skills,
  selectedSlugs,
  isCollapsed,
  onToggleSlug,
  onToggleCategory,
}: {
  category: string;
  skills: Skill[];
  selectedSlugs: string[];
  isCollapsed: boolean;
  onToggleSlug: (slug: string) => void;
  onToggleCategory: (category: string) => void;
}) {
  const Chevron = isCollapsed ? ChevronRight : ChevronDown;
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleCategory(category)}
        aria-expanded={!isCollapsed}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-semibold hover:bg-accent"
      >
        <Chevron className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">{category}</span>
        <span className="text-xs font-normal text-muted-foreground">({skills.length})</span>
      </button>
      {!isCollapsed && (
        <div className="flex flex-col pl-4">
          {skills.map((skill) => (
            <SkillRow
              key={skill.slug}
              skill={skill}
              checked={selectedSlugs.includes(skill.slug)}
              onToggle={() => onToggleSlug(skill.slug)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SkillGroups({
  skills,
  selectedSlugs,
  collapsed,
  onToggleSlug,
  onToggleCategory,
}: {
  skills: Skill[];
  selectedSlugs: string[];
  collapsed: ReadonlySet<string>;
  onToggleSlug: (slug: string) => void;
  onToggleCategory: (category: string) => void;
}) {
  const groups = groupSkillsByCategory(skills);
  if (groups.length === 0) {
    return <p className="px-2 py-4 text-sm text-muted-foreground">No skills match your search.</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {groups.map((group) => (
        <SkillCategoryGroup
          key={group.category}
          category={group.category}
          skills={group.skills}
          selectedSlugs={selectedSlugs}
          isCollapsed={collapsed.has(group.category)}
          onToggleSlug={onToggleSlug}
          onToggleCategory={onToggleCategory}
        />
      ))}
    </div>
  );
}
