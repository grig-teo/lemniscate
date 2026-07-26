import { formatCostUsd, formatTokens, tokenBudgetState } from '@/lib/token-usage';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

const STATE_STYLES = {
  exceeded: 'border-destructive/50 bg-destructive/10 text-destructive',
  warning: 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  neutral: 'border-muted-foreground/40 bg-muted text-muted-foreground',
} as const;

/**
 * LLM token-usage badge for a task; renders nothing until tokens were burned.
 * While the task is running, consumption against the effective maxTokensPerRun
 * budget escalates the style (amber ≥80%, red at the cap); finished tasks
 * always show the neutral final tally. Appends the estimated cost when the
 * backend computed one.
 */
export function TokensBadge({
  used,
  max,
  running = false,
  costUsd,
  className,
}: {
  used: number;
  max?: number | null;
  running?: boolean;
  costUsd?: number | null;
  className?: string;
}) {
  if (used <= 0) return null;
  const state = running ? tokenBudgetState(used, max) : 'none';
  const style =
    state === 'exceeded' ? STATE_STYLES.exceeded : state === 'warning' ? STATE_STYLES.warning : STATE_STYLES.neutral;
  const title =
    max != null && max > 0
      ? `${used.toLocaleString()} of ${max.toLocaleString()} budgeted tokens`
      : `${used.toLocaleString()} LLM tokens used`;
  return (
    <Badge variant="outline" className={cn('shrink-0 font-mono', style, className)} title={title}>
      {formatTokens(used)} tok{costUsd != null ? ` · ${formatCostUsd(costUsd)}` : ''}
    </Badge>
  );
}
