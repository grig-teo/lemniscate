import * as React from 'react';
import { FolderTree, X } from 'lucide-react';

import {
  AGENTS_MD_MAX_CHARS,
  formatFileSize,
  readAgentsMdFile,
  type AgentsMdAssignment,
  type UploadedAgentsMd,
} from '@/lib/create-repo';
import {
  previewStructure,
  useMcpLibrary,
  useSkillLibrary,
  type LibraryItem,
} from '@/lib/library';
import { LibrarySearchSelect } from '@/components/library/LibrarySearchSelect';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * Sections of the create-repository dialog:
 * - first-prompt field + structure preview with per-folder AGENTS.md pickers,
 * - skills multi-select (search-activated, paginated),
 * - MCP servers multi-select (search-activated, paginated).
 */

// ---------------------------------------------------------------------------
// Shared multi-select state (skills, MCP servers): slug → display name.
// ---------------------------------------------------------------------------

export function useLibraryMultiSelect() {
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<ReadonlyMap<string, string>>(new Map());

  const toggle = (item: LibraryItem) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.slug)) next.delete(item.slug);
      else next.set(item.slug, item.name);
      return next;
    });
  };

  const reset = () => {
    setSearch('');
    setPage(1);
    setSelected(new Map());
  };

  return {
    search,
    setSearch,
    page,
    setPage,
    selected,
    slugs: [...selected.keys()],
    toggle,
    remove: (slug: string) =>
      setSelected((prev) => {
        const next = new Map(prev);
        next.delete(slug);
        return next;
      }),
    reset,
  };
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-medium text-muted-foreground">{children}</span>;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export function SkillsSection({ selection }: { selection: ReturnType<typeof useLibraryMultiSelect> }) {
  const result = useSkillLibrary(selection.search, selection.page, 'skill');
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <SectionLabel>Skills (saved to .agents/skills/)</SectionLabel>
      <SelectionChips selected={selection.selected} onRemove={selection.remove} />
      <LibrarySearchSelect
        label="Skills"
        placeholder="Type to search skills…"
        search={selection.search}
        onSearchChange={selection.setSearch}
        page={selection.page}
        onPageChange={selection.setPage}
        result={result.data}
        isLoading={result.isFetching}
        isSelected={(item) => selection.selected.has(item.slug)}
        onToggle={selection.toggle}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export function McpSection({ selection }: { selection: ReturnType<typeof useLibraryMultiSelect> }) {
  const result = useMcpLibrary(selection.search, selection.page);
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <SectionLabel>MCP servers (saved to .mcp.json)</SectionLabel>
      <SelectionChips selected={selection.selected} onRemove={selection.remove} />
      <LibrarySearchSelect
        label="MCP servers"
        placeholder="Type to search MCP servers…"
        search={selection.search}
        onSearchChange={selection.setSearch}
        page={selection.page}
        onPageChange={selection.setPage}
        result={result.data}
        isLoading={result.isFetching}
        isSelected={(item) => selection.selected.has(item.slug)}
        onToggle={selection.toggle}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// First prompt + structure preview + per-folder AGENTS.md
// ---------------------------------------------------------------------------

export interface FolderAgentsMd {
  skillId?: string;
  label?: string;
  upload?: UploadedAgentsMd | null;
}

const PREVIEW_MIN_CHARS = 20;

export function useInitProject() {
  const [prompt, setPrompt] = React.useState('');
  const [folders, setFolders] = React.useState<string[] | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [assignments, setAssignments] = React.useState<Record<string, FolderAgentsMd>>({});
  const [openFolder, setOpenFolder] = React.useState<string | null>(null);
  const [pickerSearch, setPickerSearch] = React.useState('');
  const [pickerPage, setPickerPage] = React.useState(1);

  const runPreview = async () => {
    if (prompt.trim().length < 3 || previewing) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      setFolders(await previewStructure(prompt.trim()));
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Structure preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  // Auto-preview once when the field loses focus with a meaningful prompt.
  const onPromptBlur = () => {
    if (folders === null && prompt.trim().length >= PREVIEW_MIN_CHARS) {
      void runPreview();
    }
  };

  const assign = (folder: string, value: FolderAgentsMd | null) => {
    setAssignments((prev) => {
      const next = { ...prev };
      if (value === null) delete next[folder];
      else next[folder] = value;
      return next;
    });
  };

  const openPicker = (folder: string | null) => {
    setOpenFolder(folder);
    setPickerSearch('');
    setPickerPage(1);
  };

  const reset = () => {
    setPrompt('');
    setFolders(null);
    setPreviewing(false);
    setPreviewError(null);
    setAssignments({});
    openPicker(null);
  };

  // Final agentsMdFiles for the create body: explicit choices plus the
  // default template on the root folder when the user picked nothing there.
  const agentsMdFiles = (defaultTemplateId: string | null): AgentsMdAssignment[] => {
    const files: AgentsMdAssignment[] = [];
    for (const folder of folders ?? ['/']) {
      const choice = assignments[folder];
      if (choice?.upload) {
        files.push({ folder, content: choice.upload.content });
      } else if (choice?.skillId) {
        files.push({ folder, skillId: choice.skillId });
      } else if (folder === '/' && defaultTemplateId) {
        files.push({ folder: '/', skillId: defaultTemplateId });
      }
    }
    return files;
  };

  return {
    prompt,
    setPrompt,
    onPromptBlur,
    folders,
    previewing,
    previewError,
    runPreview,
    assignments,
    assign,
    openFolder,
    openPicker,
    pickerSearch,
    setPickerSearch,
    pickerPage,
    setPickerPage,
    agentsMdFiles,
    reset,
  };
}

function choiceSummary(choice: FolderAgentsMd | undefined, isRoot: boolean): string {
  if (choice?.upload) return choice.upload.name;
  if (choice?.label) return choice.label;
  return isRoot ? 'Default template' : 'None';
}

function FolderUploadInput({
  onUpload,
}: {
  onUpload: (upload: UploadedAgentsMd) => void;
}) {
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

function FolderRow({
  folder,
  init,
}: {
  folder: string;
  init: ReturnType<typeof useInitProject>;
}) {
  const isRoot = folder === '/';
  const choice = init.assignments[folder];
  const isOpen = init.openFolder === folder;
  const result = useSkillLibrary(init.pickerSearch, init.pickerPage, 'agents_md');
  return (
    <div className="min-w-0 rounded-md border">
      <button
        type="button"
        onClick={() => init.openPicker(isOpen ? null : folder)}
        aria-expanded={isOpen}
        className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
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
            search={init.pickerSearch}
            onSearchChange={init.setPickerSearch}
            page={init.pickerPage}
            onPageChange={init.setPickerPage}
            result={result.data}
            isLoading={result.isFetching}
            isSelected={(item) => choice?.skillId === item.id}
            onToggle={(item) =>
              init.assign(folder, choice?.skillId === item.id ? null : { skillId: item.id, label: item.name })
            }
          />
          <FolderUploadInput
            onUpload={(upload) => init.assign(folder, { upload, label: upload.name })}
          />
          {choice?.upload && (
            <p className="truncate px-2 pb-1 text-xs text-muted-foreground">
              {choice.upload.name} ({formatFileSize(choice.upload.size)})
              {choice.upload.truncated && ` — truncated to ${AGENTS_MD_MAX_CHARS.toLocaleString()} chars`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function InitProjectSection({ init }: { init: ReturnType<typeof useInitProject> }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <SectionLabel>First prompt — describes the project, runs as the first task</SectionLabel>
      <Textarea
        value={init.prompt}
        onChange={(event) => init.setPrompt(event.target.value)}
        onBlur={init.onPromptBlur}
        placeholder="e.g. A Next.js shop with a product catalog, cart and Stripe checkout"
        rows={3}
        className="min-w-0"
        aria-label="First prompt"
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={init.prompt.trim().length < 3 || init.previewing}
          onClick={() => void init.runPreview()}
        >
          <FolderTree className="mr-1.5 h-4 w-4" aria-hidden />
          {init.previewing ? 'Previewing…' : 'Preview structure'}
        </Button>
        {init.previewError && <span className="text-xs text-destructive">{init.previewError}</span>}
      </div>
      {init.folders !== null && (
        <div className="flex min-w-0 flex-col gap-1">
          <SectionLabel>AGENTS.md per folder</SectionLabel>
          {init.folders.map((folder) => (
            <FolderRow key={folder} folder={folder} init={init} />
          ))}
        </div>
      )}
    </section>
  );
}
