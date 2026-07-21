import * as React from 'react';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';

import {
  useSkillCategories,
  useSkills,
  useUpdateRepository,
  type Repository,
  type Skill,
} from '@/lib/hooks';
import { filterSelectedChips, groupSkillsByCategory, toggleSlug } from '@/lib/skills';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const AGENTS_MD_NOTE = 'Used only when this repository has no AGENTS.md in its root.';

/** Draft selection state, re-synced from the repository each time the dialog opens. */
function useSkillsDraft(repository: Repository | null, open: boolean) {
  const [search, setSearch] = React.useState('');
  const [category, setCategory] = React.useState<string | null>(null);
  const [selectedSlugs, setSelectedSlugs] = React.useState<string[]>([]);
  const [agentsMdSkillId, setAgentsMdSkillId] = React.useState<string | null>(null);
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());

  React.useEffect(() => {
    if (!open) return;
    setSearch('');
    setCategory(null);
    setSelectedSlugs(repository?.skillSlugs ?? []);
    setAgentsMdSkillId(repository?.agentsMdSkillId ?? null);
    setCollapsed(new Set());
  }, [open, repository]);

  const toggleCategory = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return {
    search,
    setSearch,
    category,
    setCategory,
    selectedSlugs,
    toggleSlug: (slug: string) => setSelectedSlugs((prev) => toggleSlug(prev, slug)),
    removeSlug: (slug: string) => setSelectedSlugs((prev) => prev.filter((s) => s !== slug)),
    agentsMdSkillId,
    setAgentsMdSkillId,
    collapsed,
    toggleCategory,
  };
}

function SelectedChips({
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

function SkillGroups({
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
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.category);
        const Chevron = isCollapsed ? ChevronRight : ChevronDown;
        return (
          <div key={group.category}>
            <button
              type="button"
              onClick={() => onToggleCategory(group.category)}
              aria-expanded={!isCollapsed}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-semibold hover:bg-accent"
            >
              <Chevron className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{group.category}</span>
              <span className="text-xs font-normal text-muted-foreground">
                ({group.skills.length})
              </span>
            </button>
            {!isCollapsed && (
              <div className="flex flex-col pl-4">
                {group.skills.map((skill) => (
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
      })}
    </div>
  );
}

function AgentsMdSection({
  skills,
  value,
  onChange,
}: {
  skills: Skill[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const templates = skills.filter((skill) => skill.kind === 'agents_md');
  if (templates.length === 0) return null;
  return (
    <section className="flex flex-col gap-1 border-t pt-3">
      <h3 className="text-sm font-semibold">AGENTS.md template</h3>
      <p className="text-xs text-muted-foreground">{AGENTS_MD_NOTE}</p>
      <div role="radiogroup" aria-label="AGENTS.md template" className="flex flex-col">
        <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
          <input
            type="radio"
            name="agents-md-template"
            checked={value === null}
            onChange={() => onChange(null)}
            className="h-4 w-4 shrink-0 accent-primary"
          />
          None
        </label>
        {templates.map((skill) => (
          <label
            key={skill.id}
            className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
          >
            <input
              type="radio"
              name="agents-md-template"
              checked={value === skill.id}
              onChange={() => onChange(skill.id)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{skill.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {skill.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

/**
 * Repository-level skills picker: instruction packs injected into the agent's
 * system prompt, plus one AGENTS.md template for repos without a root
 * AGENTS.md. Saved via PATCH /api/repositories/:id and inherited by both
 * manual tasks and auto proposals.
 */
export function SkillsDialog({
  open,
  onOpenChange,
  repository,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repository: Repository | null;
}) {
  const draft = useSkillsDraft(repository, open);
  const skillsQuery = useSkills(draft.search, draft.category);
  const categoriesQuery = useSkillCategories();
  const updateRepository = useUpdateRepository();
  const skills = skillsQuery.data ?? [];

  const save = () => {
    if (!repository) return;
    updateRepository.mutate(
      {
        id: repository.id,
        patch: { skillSlugs: draft.selectedSlugs, agentsMdSkillId: draft.agentsMdSkillId },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Repository skills</DialogTitle>
          <DialogDescription>
            {repository
              ? `Skills for ${repository.fullName} — injected into the agent's system prompt on every task and proposal.`
              : 'Select a repository first.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3">
          <SelectedChips
            selectedSlugs={draft.selectedSlugs}
            skills={skills}
            onRemove={draft.removeSlug}
          />

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={draft.search}
                onChange={(event) => draft.setSearch(event.target.value)}
                placeholder="Search skills by name or content…"
                aria-label="Search skills"
                className="pl-8"
              />
            </div>
            <Select
              value={draft.category ?? 'all'}
              onValueChange={(v) => draft.setCategory(v === 'all' ? null : v)}
            >
              <SelectTrigger className="h-9 w-44 shrink-0" aria-label="Category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {(categoriesQuery.data ?? []).map((cat) => (
                  <SelectItem key={cat.name} value={cat.name}>
                    {cat.name} ({cat.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ScrollArea className="h-72 rounded-md border">
            <div className="flex flex-col gap-3 p-2">
              <SkillGroups
                skills={skills}
                selectedSlugs={draft.selectedSlugs}
                collapsed={draft.collapsed}
                onToggleSlug={draft.toggleSlug}
                onToggleCategory={draft.toggleCategory}
              />
            </div>
          </ScrollArea>

          <AgentsMdSection
            skills={skills}
            value={draft.agentsMdSkillId}
            onChange={draft.setAgentsMdSkillId}
          />

          {updateRepository.isError && (
            <p className="text-sm text-destructive">{updateRepository.error.message}</p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={save} disabled={!repository || updateRepository.isPending}>
            {updateRepository.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
