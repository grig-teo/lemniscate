/** Proposal priorities, highest first — mirrors PROPOSAL_PRIORITIES on the backend. */
export const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

/** Badge colors per priority (matches the StatusBadge palette style). */
export const PRIORITY_STYLES: Record<string, string> = {
  critical: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  high: 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400',
  medium: 'border-slate-500/40 bg-slate-500/10 text-slate-500 dark:text-slate-400',
  low: 'border-muted-foreground/40 bg-muted text-muted-foreground',
};
