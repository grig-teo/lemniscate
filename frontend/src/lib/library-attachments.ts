/**
 * Shared state for the library-attachment editors (skills multi-select, MCP
 * servers multi-select, per-folder AGENTS.md assignments). Used by the
 * create-repository dialog and the pending-task detail editor — the rendered
 * part lives in components/library/LibraryAttachments.tsx.
 */
import * as React from 'react';

import type { AgentsMdAssignment, UploadedAgentsMd } from '@/lib/create-repo';
import type { LibraryItem } from '@/lib/library';

/** One folder's AGENTS.md choice: a template (skillId) or an uploaded file. */
export interface FolderAgentsMd {
  skillId?: string;
  label?: string;
  upload?: UploadedAgentsMd | null;
}

// ---------------------------------------------------------------------------
// Multi-select (skills, MCP servers): slug → display name.
// ---------------------------------------------------------------------------

export function useLibraryMultiSelect(initial?: ReadonlyMap<string, string>) {
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<ReadonlyMap<string, string>>(initial ?? new Map());

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

// ---------------------------------------------------------------------------
// AGENTS.md assignments keyed by folder, plus the folder list itself.
// ---------------------------------------------------------------------------

export interface AgentsMdInitial {
  folder: string;
  value: FolderAgentsMd;
}

/** Union of requested folders and assignment folders, '/' first, order kept. */
export function mergeFolders(folders: string[], assignments: string[]): string[] {
  const merged = new Set<string>(['/', ...folders, ...assignments]);
  return [...merged];
}

export function useAgentsMdAssignments(initial?: AgentsMdInitial[], initialFolders?: string[]) {
  const [folders, setFolders] = React.useState<string[]>(() =>
    mergeFolders(initialFolders ?? [], (initial ?? []).map((entry) => entry.folder)),
  );
  const [assignments, setAssignments] = React.useState<Record<string, FolderAgentsMd>>(() =>
    Object.fromEntries((initial ?? []).map((entry) => [entry.folder, entry.value])),
  );
  const [openFolder, setOpenFolder] = React.useState<string | null>(null);
  const [pickerSearch, setPickerSearch] = React.useState('');
  const [pickerPage, setPickerPage] = React.useState(1);

  const assign = (folder: string, value: FolderAgentsMd | null) => {
    setAssignments((prev) => {
      const next = { ...prev };
      if (value === null) delete next[folder];
      else next[folder] = value;
      return next;
    });
  };

  // Replace the folder list (e.g. after a structure preview), keeping any
  // folder that already has an assignment so a choice is never dropped.
  const replaceFolders = (next: string[]) => {
    setFolders(mergeFolders(next, Object.keys(assignments)));
  };

  const openPicker = (folder: string | null) => {
    setOpenFolder(folder);
    setPickerSearch('');
    setPickerPage(1);
  };

  const reset = () => {
    setFolders(['/']);
    setAssignments({});
    openPicker(null);
  };

  // Final agentsMdFiles for a request body. With defaultTemplateId the root
  // folder falls back to the default template when nothing was picked there
  // (create-dialog behavior); without it unassigned folders produce nothing.
  const toAssignments = (defaultTemplateId?: string | null): AgentsMdAssignment[] => {
    const files: AgentsMdAssignment[] = [];
    for (const folder of folders) {
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
    folders,
    assignments,
    assign,
    replaceFolders,
    openFolder,
    openPicker,
    pickerSearch,
    setPickerSearch,
    pickerPage,
    setPickerPage,
    toAssignments,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Combined hook: one object passed to <LibraryAttachments />.
// ---------------------------------------------------------------------------

export interface LibraryAttachmentsInitial {
  skills?: ReadonlyMap<string, string>;
  mcpServers?: ReadonlyMap<string, string>;
  agentsMd?: AgentsMdInitial[];
  folders?: string[];
}

export function useLibraryAttachments(initial?: LibraryAttachmentsInitial) {
  const skills = useLibraryMultiSelect(initial?.skills);
  const mcpServers = useLibraryMultiSelect(initial?.mcpServers);
  const agentsMd = useAgentsMdAssignments(initial?.agentsMd, initial?.folders);

  const reset = () => {
    skills.reset();
    mcpServers.reset();
    agentsMd.reset();
  };

  return { skills, mcpServers, agentsMd, reset };
}

export type LibraryAttachmentsState = ReturnType<typeof useLibraryAttachments>;
