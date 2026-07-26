import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<string, string> = {
  pending: 'border-slate-500/40 bg-slate-500/10 text-slate-500 dark:text-slate-400',
  queued: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  running: 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  awaiting_review: 'border-purple-500/40 bg-purple-500/10 text-purple-600 dark:text-purple-400',
  // GitHub's merged-PR purple.
  done: 'border-[#8250df]/40 bg-[#8250df]/10 text-[#8250df]',
  failed: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  // PR closed without merge — same red family as failed, distinct from done.
  closed: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
};

/** Colored badge for a task status (pending/queued/running/awaiting_review/done/failed/closed). */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const style = STATUS_STYLES[status] ?? 'border-muted-foreground/40 bg-muted text-muted-foreground';
  return (
    <Badge variant="outline" className={cn('shrink-0 capitalize', style, className)}>
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}
