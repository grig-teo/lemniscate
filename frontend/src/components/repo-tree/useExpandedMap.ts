import * as React from 'react';

import { readPersisted, writePersisted } from '@/lib/persist';

const EXPANDED_STORAGE_KEY = 'lemniscate.expanded-repos';

/** Expanded/collapsed state for the repo rows of the sidebar tree, persisted. */
export function useExpandedMap() {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>(() =>
    readPersisted(EXPANDED_STORAGE_KEY, {}),
  );
  React.useEffect(() => writePersisted(EXPANDED_STORAGE_KEY, expanded), [expanded]);
  const toggle = React.useCallback(
    (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] })),
    [],
  );
  return { expanded, toggle };
}
