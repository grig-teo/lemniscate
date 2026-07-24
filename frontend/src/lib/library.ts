/**
 * Prompt-library client layer (skills / AGENTS.md templates / MCP servers).
 * Kept separate from lib/hooks.ts: the pickers in the create-repository
 * dialog use search-activated, paginated queries (5 per page) that only fire
 * while the search field is non-empty.
 */
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

export interface LibraryItem {
  id: string;
  slug: string;
  name: string;
  description: string;
}

export interface LibraryPage {
  items: LibraryItem[];
  total: number;
  page: number;
  pageSize: number;
}

export const LIBRARY_PAGE_SIZE = 5;
const SEARCH_DEBOUNCE_MS = 250;

/** Total page count for a paginated library list (at least 1). */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function canPrevPage(page: number): boolean {
  return page > 1;
}

export function canNextPage(page: number, total: number, pageSize: number): boolean {
  return page < pageCount(total, pageSize);
}

/** Clamp a requested page into the valid range for the given total. */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, page), pageCount(total, pageSize));
}

function useDebounced(value: string): string {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

function libraryParams(search: string, page: number, kind?: 'skill' | 'agents_md'): string {
  const params = new URLSearchParams();
  params.set('search', search);
  params.set('page', String(page));
  params.set('pageSize', String(LIBRARY_PAGE_SIZE));
  if (kind) params.set('kind', kind);
  return params.toString();
}

interface RawLibraryPage {
  total: number;
  page: number;
  pageSize: number;
}

function toLibraryPage(raw: RawLibraryPage, items: LibraryItem[]): LibraryPage {
  return { items, total: raw.total, page: raw.page, pageSize: raw.pageSize };
}

/**
 * Search-activated, paginated library query shared by the skills / AGENTS.md
 * / MCP pickers. Disabled while the search is blank — the dropdown renders
 * nothing until the user types.
 */
function useLibrarySearch(path: '/api/skills' | '/api/mcp-servers', search: string, page: number, kind?: 'skill' | 'agents_md') {
  const debouncedSearch = useDebounced(search);
  const active = debouncedSearch.trim().length > 0;
  return useQuery({
    queryKey: ['library', path, kind ?? null, debouncedSearch, page],
    queryFn: async () => {
      const query = libraryParams(debouncedSearch, page, kind);
      if (path === '/api/skills') {
        const res = await api.get<{ skills: LibraryItem[] } & RawLibraryPage>(
          `${path}?${query}`,
        );
        return toLibraryPage(res, res.skills);
      }
      const res = await api.get<{ servers: LibraryItem[] } & RawLibraryPage>(
        `${path}?${query}`,
      );
      return toLibraryPage(res, res.servers);
    },
    enabled: active,
    placeholderData: (previous) => previous,
  });
}

export function useSkillLibrary(search: string, page: number, kind: 'skill' | 'agents_md' = 'skill') {
  return useLibrarySearch('/api/skills', search, page, kind);
}

export function useMcpLibrary(search: string, page: number) {
  return useLibrarySearch('/api/mcp-servers', search, page);
}

/** All AGENTS.md templates (unpaginated — a handful of rows) for default resolution. */
export function useAgentsMdTemplates() {
  return useQuery({
    queryKey: ['library', 'agents-md-templates'],
    queryFn: () =>
      api
        .get<{ skills: LibraryItem[] }>('/api/skills?kind=agents_md')
        .then((res) => res.skills),
  });
}

/** POST /api/library/structure-preview — folder list for a first project prompt. */
export async function previewStructure(prompt: string): Promise<string[]> {
  const res = await api.post<{ folders: string[] }>('/api/library/structure-preview', { prompt });
  return res.folders;
}

/**
 * Debounced directory-tree query for GET /api/repositories/:id/folders:
 * one shallow clone per search term, folders only. Disabled without a repo id.
 */
export function useRepoFolders(repositoryId: string | null | undefined, search: string) {
  const debouncedSearch = useDebounced(search);
  return useQuery({
    queryKey: ['repo-folders', repositoryId ?? null, debouncedSearch],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      return api
        .get<{ folders: string[] }>(`/api/repositories/${repositoryId}/folders${suffix}`)
        .then((res) => res.folders);
    },
    enabled: Boolean(repositoryId),
    placeholderData: (previous) => previous,
  });
}
