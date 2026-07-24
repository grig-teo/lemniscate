import * as React from 'react';
import { Search, X } from 'lucide-react';

import {
  useSkillCategories,
  useSkills,
  useUpdateRepository,
  type Repository,
  type Skill,
} from '@/lib/hooks';
import { toggleSlug } from '@/lib/skills';
import { SelectedChips, SkillGroups } from '@/components/skills/SkillPicker';
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
      <DialogContent className="overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Repository skills</DialogTitle>
          <DialogDescription className="break-words">
            {repository
              ? `Skills for ${repository.fullName} — injected into the agent's system prompt on every task and proposal.`
              : 'Select a repository first.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-3">
          <SelectedChips
            selectedSlugs={draft.selectedSlugs}
            skills={skills}
            onRemove={draft.removeSlug}
          />

          <div className="flex min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={draft.search}
                onChange={(event) => draft.setSearch(event.target.value)}
                placeholder="Search skills by name or content…"
                aria-label="Search skills"
                className="pl-8 pr-8"
              />
              {draft.search !== '' && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => draft.setSearch('')}
                  className="absolute right-2 top-2.5 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
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
            <div className="flex min-w-0 flex-col gap-3 p-2">
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
