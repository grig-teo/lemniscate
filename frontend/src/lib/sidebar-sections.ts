import * as React from 'react';

import { readPersisted, writePersisted } from '@/lib/persist';

/** Collapsible sections of the left sidebar (RepoTree / Services / Devices). */
export type SidebarSectionId = 'repositories' | 'services' | 'devices';

export const SECTION_IDS: readonly SidebarSectionId[] = ['repositories', 'services', 'devices'];

export const SECTIONS_STORAGE_KEY = 'lemniscate.collapsed-sidebar-sections';

type CollapsedMap = Record<string, boolean>;

/** Sections are visible by default; only an explicit `true` collapses one. */
export function isSectionCollapsed(collapsed: CollapsedMap, id: SidebarSectionId): boolean {
  return collapsed[id] === true;
}

/** Immutably flip one section's collapsed flag, leaving the others untouched. */
export function toggleSection(collapsed: CollapsedMap, id: SidebarSectionId): CollapsedMap {
  return { ...collapsed, [id]: !isSectionCollapsed(collapsed, id) };
}

/** Collapsed state of all left-pane sections, persisted across sessions. */
export function useSidebarSections() {
  const [collapsed, setCollapsed] = React.useState<CollapsedMap>(() =>
    readPersisted(SECTIONS_STORAGE_KEY, {}),
  );
  React.useEffect(() => writePersisted(SECTIONS_STORAGE_KEY, collapsed), [collapsed]);
  const toggle = React.useCallback(
    (id: SidebarSectionId) => setCollapsed((prev) => toggleSection(prev, id)),
    [],
  );
  return { collapsed, toggle };
}
