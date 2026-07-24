import * as React from 'react';
import { FolderTree, Loader2, Search, X } from 'lucide-react';

import {
  AGENTS_MD_MAX_CHARS,
  formatFileSize,
  readAgentsMdFile,
  type UploadedAgentsMd,
} from '@/lib/create-repo';
import { useMcpLibrary, useRepoFolders, useSkillLibrary } from '@/lib/library';
import type { LibraryAttachmentsState } from '@/lib/library-attachments';
import { McpCreateEntry, SkillUploadEntry } from '@/components/library/LibraryCreateEntry';
import { LibrarySearchSelect } from '@/components/library/LibrarySearchSelect';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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

const FOLDER_BROWSER_PAGE = 30;

/** Search + scroll-paginated checkbox tree of the repository's folders. */
function FolderBrowser({
  repositoryId,
  selected,
  onToggle,
}: {
  repositoryId: string;
  selected: string[];
  onToggle: (folder: string) => void;
}) {
  const [search, setSearch] = React.useState('');
  const [visible, setVisible] = React.useState(FOLDER_BROWSER_PAGE);
  const foldersQuery = useRepoFolders(repositoryId, search);
  // '/' is always present as its own row — the browser lists real folders only.
  const folders = (foldersQuery.data ?? []).filter((folder) => folder !== '/');

  React.useEffect(() => {
    setVisible(FOLDER_BROWSER_PAGE);
  }, [foldersQuery.data]);

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      setVisible((prev) => Math.min(prev + FOLDER_BROWSER_PAGE, folders.length));
    }
  };

  return (
    <div className="min-w-0 rounded-md border">
      <div className="relative border-b p-1.5">
        <Search
          className="pointer-events-none absolute left-3.5 top-3 h-3.5 w-3.5 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search folders…"
          aria-label="Search folders"
          className="h-8 pl-7 pr-7 text-xs"
        />
        {search !== '' && (
          <button
            type="button"
            aria-label="Clear folder search"
            onClick={() => setSearch('')}
            className="absolute right-3 top-3 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        )}
      </div>
      <div className="max-h-44 overflow-y-auto p-1" onScroll={onScroll}>
        {foldersQuery.isLoading && (
          <p className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            Cloning repository…
          </p>
        )}
        {foldersQuery.isError && (
          <p className="px-2 py-2 text-xs text-destructive">Failed to load folders.</p>
        )}
        {!foldersQuery.isLoading && !foldersQuery.isError && folders.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">No folders match.</p>
        )}
        {folders.slice(0, visible).map((folder) => (
          <label
            key={folder}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent"
          >
            <input
              type="checkbox"
              checked={selected.includes(folder)}
              onChange={() => onToggle(folder)}
              className="h-3.5 w-3.5 shrink-0 accent-primary"
            />
            <span className="min-w-0 truncate font-mono">{folder}</span>
          </label>
        ))}
        {visible < folders.length && (
          <p className="px-2 py-1 text-center text-[10px] text-muted-foreground">
            Scroll for more ({visible}/{folders.length})
          </p>
        )}
      </div>
    </div>
  );
}

function AgentsMdSection({
  state,
  repositoryId,
}: {
  state: LibraryAttachmentsState;
  repositoryId?: string;
}) {
  const [browsing, setBrowsing] = React.useState(false);
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <SectionLabel>AGENTS.md per folder</SectionLabel>
      {state.agentsMd.folders.map((folder) => (
        <FolderRow key={folder} folder={folder} state={state} />
      ))}
      {repositoryId && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 self-start"
            onClick={() => setBrowsing((value) => !value)}
            aria-expanded={browsing}
          >
            <FolderTree className="h-3.5 w-3.5" aria-hidden />
            Browse repo folders
          </Button>
          {browsing && (
            <FolderBrowser
              repositoryId={repositoryId}
              selected={state.agentsMd.folders}
              onToggle={state.agentsMd.toggleFolder}
            />
          )}
        </>
      )}
    </section>
  );
}
