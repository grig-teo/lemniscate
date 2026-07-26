/**
 * Reusable library-attachment editor: skills multi-select, MCP servers
 * multi-select and per-folder AGENTS.md assignments. Rendered inside the
 * create-repository dialog and the pending-task detail editor; state lives
 * in lib/library-attachments.ts (useLibraryAttachments). The AGENTS.md
 * section lives in AgentsMdSection.tsx (AGENTS.md section 2).
 */
import { X } from 'lucide-react';

import { useMcpLibrary, useSkillLibrary } from '@/lib/library';
import type { LibraryAttachmentsState } from '@/lib/library-attachments';
import { AgentsMdSection } from '@/components/library/AgentsMdSection';
import { McpCreateEntry, SkillUploadEntry } from '@/components/library/LibraryCreateEntry';
import { LibrarySearchSelect } from '@/components/library/LibrarySearchSelect';
import { SectionLabel } from '@/components/library/SectionLabel';
import { SkillPreviewButton } from '@/components/skills/SkillPreviewDialog';
import { Badge } from '@/components/ui/badge';

function SelectionChips({
  selected,
  onRemove,
}: {
  selected: ReadonlyMap<string, string>;
  onRemove: (slug: string) => void;
}) {
  if (selected.size === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5" aria-label="Selected">
      {[...selected.entries()].map(([slug, name]) => (
        <Badge key={slug} variant="secondary" className="gap-1 pr-1">
          <span className="max-w-40 truncate">{name}</span>
          <button
            type="button"
            aria-label={`Remove ${name}`}
            onClick={() => onRemove(slug)}
            className="rounded-full p-0.5 hover:bg-background/60"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </Badge>
      ))}
    </div>
  );
}

function SkillsSection({ state }: { state: LibraryAttachmentsState }) {
  const result = useSkillLibrary(state.skills.search, state.skills.page, 'skill');
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <SectionLabel>Skills</SectionLabel>
      <SelectionChips selected={state.skills.selected} onRemove={state.skills.remove} />
      <LibrarySearchSelect
        label="Skills"
        placeholder="Type to search skills…"
        search={state.skills.search}
        onSearchChange={state.skills.setSearch}
        page={state.skills.page}
        onPageChange={state.skills.setPage}
        result={result.data}
        isLoading={result.isFetching}
        isSelected={(item) => state.skills.selected.has(item.slug)}
        onToggle={state.skills.toggle}
        renderItemActions={(item) => <SkillPreviewButton slug={item.slug} />}
        emptyContent={<SkillUploadEntry onCreated={state.skills.toggle} />}
      />
    </section>
  );
}

function McpSection({ state }: { state: LibraryAttachmentsState }) {
  const result = useMcpLibrary(state.mcpServers.search, state.mcpServers.page);
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <SectionLabel>MCP servers</SectionLabel>
      <SelectionChips selected={state.mcpServers.selected} onRemove={state.mcpServers.remove} />
      <LibrarySearchSelect
        label="MCP servers"
        placeholder="Type to search MCP servers…"
        search={state.mcpServers.search}
        onSearchChange={state.mcpServers.setSearch}
        page={state.mcpServers.page}
        onPageChange={state.mcpServers.setPage}
        result={result.data}
        isLoading={result.isFetching}
        isSelected={(item) => state.mcpServers.selected.has(item.slug)}
        onToggle={state.mcpServers.toggle}
        emptyContent={<McpCreateEntry onCreated={state.mcpServers.toggle} />}
      />
    </section>
  );
}

export function LibraryAttachments({
  state,
  columns = false,
  repositoryId,
}: {
  state: LibraryAttachmentsState;
  /** Render the three sections side by side on one line (sm+). */
  columns?: boolean;
  /** When set, the AGENTS.md section can browse the repository's folder tree. */
  repositoryId?: string;
}) {
  if (columns) {
    return (
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
        <SkillsSection state={state} />
        <AgentsMdSection state={state} repositoryId={repositoryId} />
        <McpSection state={state} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SkillsSection state={state} />
      <McpSection state={state} />
      <AgentsMdSection state={state} repositoryId={repositoryId} />
    </div>
  );
}
