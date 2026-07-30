import { Clock } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

/**
 * Label for the LLM-generated time estimate of a pending prompt/proposal.
 * Produced by POST /api/tasks/:id/improve (see useImproveTask) and shown next
 * to the priority/effort labels in the right-pane detail; renders nothing
 * when no estimate is available.
 */
export function EstimatedTimeBadge({
  estimatedTime,
  className,
}: {
  estimatedTime?: string | null;
  className?: string;
}) {
  if (!estimatedTime) return null;
  return (
    <Badge
      variant="outline"
      className={cn('shrink-0 gap-1 px-1.5 py-0 text-[10px] text-muted-foreground', className)}
      title="LLM-generated time estimate"
    >
      <Clock className="h-2.5 w-2.5" aria-hidden />
      {estimatedTime}
    </Badge>
  );
}
