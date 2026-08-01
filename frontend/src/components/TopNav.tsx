import { Link } from 'react-router-dom';

import { BrandMark } from '@/components/BrandMark';
import { GitlemIcon } from '@/components/icons/GitlemIcon';
import { NotificationBell } from '@/components/NotificationBell';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useConnections } from '@/lib/hooks';
import { useWorkspaceSelection } from '@/lib/selection';
import { useHasActiveProcesses } from '@/lib/queries/tasks';

/**
 * Top navigation bar: logo + app name on the left (links back to the
 * landing page), theme toggle and settings dialog on the right. A gitlem
 * icon appears next to the logo once an internal git-host connection exists.
 * The logo animates only while a task is running or in review.
 */
export function TopNav() {
  const animate = useHasActiveProcesses();
  const { data: connections } = useConnections();
  const { openGitlemGrid } = useWorkspaceSelection();
  const hasGitlem = connections?.some((c) => c.provider === 'gitlem') ?? false;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2">
        <Link to="/" aria-label="Go to landing page">
          <BrandMark animate={animate} />
        </Link>
        {hasGitlem && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={openGitlemGrid}
                  aria-label="Gitlem repositories"
                >
                  <GitlemIcon className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Gitlem repositories</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      <div className="flex items-center gap-1">
        <NotificationBell />
        <ThemeToggle />
        <SettingsDialog />
      </div>
    </header>
  );
}
