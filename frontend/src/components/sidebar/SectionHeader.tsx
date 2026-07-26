import type * as React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * Shared clickable header for the left-pane sections (Repositories,
 * Services, Devices): a chevron + label button that toggles the section's
 * collapsed state, with an optional right-side action (e.g. the + button)
 * that stays clickable without triggering the toggle.
 */
export function SectionHeader({
  label,
  collapsed,
  onToggle,
  action,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="flex items-center justify-between gap-1 px-3 py-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Show' : 'Hide'} ${label}`}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <Chevron className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      </button>
      {action}
    </div>
  );
}
