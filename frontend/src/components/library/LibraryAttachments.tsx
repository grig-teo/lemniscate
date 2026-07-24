import * as React from 'react';
import { FolderTree, Loader2, X } from 'lucide-react';

import {
  AGENTS_MD_MAX_CHARS,
  formatFileSize,
  readAgentsMdFile,
  type UploadedAgentsMd,
} from '@/lib/create-repo';
import { useMcpLibrary, useSkillLibrary } from '@/lib/library';
import type { LibraryAttachmentsState } from '@/lib/library-attachments';
import { McpCreateEntry, SkillUploadEntry } from '@/components/library/LibraryCreateEntry';
import { LibrarySearchSelect } from '@/components/library/LibrarySearchSelect';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * Reusable library-attachment editor: skills multi-select, MCP servers
 * multi-select and per-folder AGENTS.md assignments. Rendered inside the
 * create-repository dialog and the pending-task detail editor; state lives
 * in lib/library-attachments.ts (useLibraryAttachments).
 */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-medium text-muted-foreground">{children}</span>;
}

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

function FolderUploadInput({ onUpload }: { onUpload: (upload: UploadedAgentsMd) => void }) {
  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    onUpload(await readAgentsMdFile(file));
  }
  return (
    <input
      type="file"
      accept=".md,.txt,text/markdown,text/plain"
      aria-label="Upload AGENTS.md file"
      onChange={(event) => void handleFile(event)}
      className="px-2 py-1 text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1 file:text-xs file:text-foreground hover:file:bg-accent"
    />
  );
}

function choiceSummary(choice: { skillId?: string; label?: string; upload?: UploadedAgentsMd | null } | undefined, isRoot: boolean): string {
  if (choice?.upload) return choice.upload.name;
  if (choice?.label) return choice.label;
  return isRoot ? 'Default template' : 'None';
}

function OrDivider() {
  return (
    <div className="flex items-center gap-2 py-1" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      <span className="text-[10px] font-medium uppercase text-muted-foreground">or</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function FolderRow({ folder, state }: { folder: string; state: LibraryAttachmentsState }) {
  const { agentsMd } = state;
  const isRoot = folder === '/';
  const choice = agentsMd.assignments[folder];
  const isOpen = agentsMd.openFolder === folder;
  const result = useSkillLibrary(agentsMd.pickerSearch, agentsMd.pickerPage, 'agents_md');
  return (
    <div className="min-w-0 rounded-md border">
      <button
        type="button"
        onClick={() => agentsMd.openPicker(isOpen ? null : folder)}
        aria-expanded={isOpen}
        className="flex h-9 w-full min-w-0 items-center gap-2 px-2 text-left text-sm hover:bg-accent"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{folder}</span>
        <span className="max-w-[45%] truncate text-xs text-muted-foreground">
          {choiceSummary(choice, isRoot)}
        </span>
      </button>
      {isOpen && (
        <div className="border-t p-1.5">
          <LibrarySearchSelect
            label={`AGENTS.md for ${folder}`}
            placeholder="Search AGENTS.md templates…"
            search={agentsMd.pickerSearch}
            onSearchChange={agentsMd.setPickerSearch}
            page={agentsMd.pickerPage}
            onPageChange={agentsMd.setPickerPage}
            result={result.data}
            isLoading={result.isFetching}
            isSelected={(item) => choice?.skillId === item.id}
            onToggle={(item) =>
              agentsMd.assign(
                folder,
                choice?.skillId === item.id ? null : { skillId: item.id, label: item.name },
              )
            }
          />
          <OrDivider />
          <FolderUploadInput
            onUpload={(upload) => agentsMd.assign(folder, { upload, label: upload.name })}
          />
          {choice?.upload && (
            <p className="truncate px-2 pb-1 text-xs text-muted-foreground">
              {choice.upload.name} ({formatFileSize(choice.upload.size)})
              {choice.upload.truncated &&
                ` — truncated to ${AGENTS_MD_MAX_CHARS.toLocaleString()} chars`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function LibraryAttachments({
  state,
  columns = false,
  onLoadFolders,
}: {
  state: LibraryAttachmentsState;
  /** Render the three sections side by side on one line (sm+). */
  columns?: boolean;
  /** When set, an AGENTS.md section button loads the repository's folder tree. */
  onLoadFolders?: () => Promise<string[]>;
}) {
  if (columns) {
    return (
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
        <SkillsSection state={state} />
        <AgentsMdSection state={state} onLoadFolders={onLoadFolders} />
        <McpSection state={state} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SkillsSection state={state} />
      <McpSection state={state} />
      <AgentsMdSection state={state} onLoadFolders={onLoadFolders} />
    </div>
  );
}

function AgentsMdSection({
  state,
  onLoadFolders,
}: {
  state: LibraryAttachmentsState;
  onLoadFolders?: () => Promise<string[]>;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <SectionLabel>AGENTS.md per folder</SectionLabel>
      {state.agentsMd.folders.map((folder) => (
        <FolderRow key={folder} folder={folder} state={state} />
      ))}
      {onLoadFolders && (
        <LoadFoldersButton
          onLoad={async () => {
            state.agentsMd.replaceFolders(await onLoadFolders());
          }}
        />
      )}
    </section>
  );
}

function LoadFoldersButton({ onLoad }: { onLoad: () => Promise<void> }) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 self-start"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          setError(null);
          onLoad()
            .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'))
            .finally(() => setLoading(false));
        }}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <FolderTree className="h-3.5 w-3.5" aria-hidden />
        )}
        Load repo folders
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
