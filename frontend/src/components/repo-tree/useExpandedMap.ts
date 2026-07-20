import * as React from 'react';

/** Expanded/collapsed state for the repo rows of the sidebar tree. */
export function useExpandedMap() {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const toggle = React.useCallback(
    (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] })),
    [],
  );
  return { expanded, toggle };
}
