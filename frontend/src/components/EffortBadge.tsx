import { Badge } from '@/components/ui/badge';

// Single source of truth for the effort label (small/medium/large) extracted
// from the inline rendering in ProposalDetail so the Kanban cards and the
// proposal detail share one shape (AGENTS.md §6).
export function EffortBadge({ effort, className }: { effort?: string | null; className?: string }) {
  if (!effort) return null;
  return (
    <Badge variant="outline" className={className ?? 'shrink-0 px-1.5 py-0 text-[10px] text-muted-foreground'}>
      {effort} effort
    </Badge>
  );
}
