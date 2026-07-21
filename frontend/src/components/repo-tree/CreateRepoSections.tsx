import * as React from 'react';
import { Search, X } from 'lucide-react';

import {
  AGENTS_MD_MAX_CHARS,
  formatFileSize,
  readAgentsMdFile,
  type UploadedAgentsMd,
} from '@/lib/create-repo';
import { useSkills } from '@/lib/hooks';
import { toggleSlug } from '@/lib/skills';
import { SelectedChips, SkillGroups } from '@/components/skills/SkillPicker';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Skills + AGENTS.md sections of the create-repository dialog: a compact
 * version of the repository-level skills picker (search, category groups,
 * selected chips) plus a template select with a custom-file upload option.
 */

/** Select sentinel: no AGENTS.md at all. */
export const AGENTS_MD_NONE = 'none';
/** Select sentinel: upload a custom AGENTS.md file instead of a template. */
export const AGENTS_MD_UPLOAD = 'upload';

/** Compact skills-selection state for the create dialog; `reset` restores defaults on close. */
export function useSkillsSelection() {
  const [search, setSearch] = React.useState('');
  const [selectedSlugs, setSelectedSlugs] = React.useState<string[]>([]);
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());

  const toggleCategory = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const reset = () => {
    setSearch('');
    setSelectedSlugs([]);
    setCollapsed(new Set());
  };

  return {
    search,
    setSearch,
    selectedSlugs,
    toggleSlug: (slug: string) => setSelectedSlugs((prev) => toggleSlug(prev, slug)),
    removeSlug: (slug: string) => setSelectedSlugs((prev) => prev.filter((s) => s !== slug)),
    collapsed,
    toggleCategory,
    reset,
  };
}

/** AGENTS.md choice state: 'none' | 'upload' | template skill id, plus the uploaded file. */
export function useAgentsMdChoice() {
  const [choice, setChoice] = React.useState(AGENTS_MD_NONE);
  const [upload, setUpload] = React.useState<UploadedAgentsMd | null>(null);

  const select = (next: string) => {
    setChoice(next);
    if (next !== AGENTS_MD_UPLOAD) setUpload(null);
  };

  const reset = () => {
    setChoice(AGENTS_MD_NONE);
    setUpload(null);
  };

  const isTemplate = choice !== AGENTS_MD_NONE && choice !== AGENTS_MD_UPLOAD;
  return {
    choice,
    select,
    upload,
    setUpload,
    skillId: isTemplate ? choice : null,
    content: choice === AGENTS_MD_UPLOAD ? (upload?.content ?? null) : null,
    reset,
  };
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-medium text-muted-foreground">{children}</span>;
}

export function SkillsSection({ selection }: { selection: ReturnType<typeof useSkillsSelection> }) {
  const skillsQuery = useSkills(selection.search);
  const skills = skillsQuery.data ?? [];
  return (
    <section className="flex flex-col gap-1.5">
      <SectionLabel>Skills</SectionLabel>
      <SelectedChips
        selectedSlugs={selection.selectedSlugs}
        skills={skills}
        onRemove={selection.removeSlug}
      />
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={selection.search}
          onChange={(event) => selection.setSearch(event.target.value)}
          placeholder="Search skills…"
          aria-label="Search skills"
          className="h-9 pl-8"
        />
      </div>
      <ScrollArea className="h-36 rounded-md border">
        <div className="p-1">
          <SkillGroups
            skills={skills}
            selectedSlugs={selection.selectedSlugs}
            collapsed={selection.collapsed}
            onToggleSlug={selection.toggleSlug}
            onToggleCategory={selection.toggleCategory}
          />
        </div>
      </ScrollArea>
    </section>
  );
}

function UploadedFileLine({
  upload,
  onClear,
}: {
  upload: UploadedAgentsMd;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
        {upload.name} ({formatFileSize(upload.size)})
        {upload.truncated && ` — truncated to ${AGENTS_MD_MAX_CHARS.toLocaleString()} chars`}
      </span>
      <button
        type="button"
        aria-label={`Remove ${upload.name}`}
        onClick={onClear}
        className="rounded-full p-0.5 hover:bg-accent"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}

function AgentsMdUploadInput({
  upload,
  onUpload,
}: {
  upload: UploadedAgentsMd | null;
  onUpload: (upload: UploadedAgentsMd | null) => void;
}) {
  const [error, setError] = React.useState<string | null>(null);

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      onUpload(await readAgentsMdFile(file));
      setError(null);
    } catch {
      setError(`Could not read ${file.name}`);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <input
        type="file"
        accept=".md,.txt,text/markdown,text/plain"
        aria-label="Upload AGENTS.md file"
        onChange={(event) => void handleFile(event)}
        className="text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1 file:text-xs file:text-foreground hover:file:bg-accent"
      />
      {upload && <UploadedFileLine upload={upload} onClear={() => onUpload(null)} />}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function AgentsMdField({ agentsMd }: { agentsMd: ReturnType<typeof useAgentsMdChoice> }) {
  const skillsQuery = useSkills('');
  const templates = (skillsQuery.data ?? []).filter((skill) => skill.kind === 'agents_md');
  return (
    <section className="flex flex-col gap-1.5">
      <SectionLabel>AGENTS.md</SectionLabel>
      <Select value={agentsMd.choice} onValueChange={agentsMd.select}>
        <SelectTrigger aria-label="AGENTS.md template" className="h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AGENTS_MD_NONE}>None</SelectItem>
          {templates.map((skill) => (
            <SelectItem key={skill.id} value={skill.id}>
              {skill.name}
            </SelectItem>
          ))}
          <SelectItem value={AGENTS_MD_UPLOAD}>Upload custom file…</SelectItem>
        </SelectContent>
      </Select>
      {agentsMd.choice === AGENTS_MD_UPLOAD && (
        <AgentsMdUploadInput upload={agentsMd.upload} onUpload={agentsMd.setUpload} />
      )}
    </section>
  );
}
