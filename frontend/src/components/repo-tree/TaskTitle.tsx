import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Truncated task title that reveals its full text in a styled tooltip on
 * hover/focus, instead of the sluggish unstyled native `title` attribute.
 * Used by the left-pane proposal, prompt, and archived-task lists, where the
 * sidebar width forces ellipsizing. Hover/focus open the tooltip; the trigger
 * is a span so it stays valid nested inside the list-row button.
 */
export function TaskTitle({
  title,
  className,
}: {
  title: string;
  className?: string;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className={cn('min-w-0 truncate', className)}>
            {title}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs whitespace-normal break-words text-left">
          {title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
