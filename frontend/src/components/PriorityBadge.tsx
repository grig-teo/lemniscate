import { PRIORITY_STYLES } from '@/lib/priority';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

/** Colored badge for a proposal priority; renders nothing when unset. */
export function PriorityBadge({
  priority,
  className,
}: {
  priority?: string | null;
  className?: string;
}) {
  if (!priority) return null;
  const style = PRIORITY_STYLES[priority] ?? 'border-muted-foreground/40 bg-muted text-muted-foreground';
  return (
    <Badge variant="outline" className={cn('shrink-0 capitalize', style, className)}>
      {priority}
    </Badge>
  );
}
