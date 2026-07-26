import { Link } from 'react-router-dom';

import { BrandMark } from '@/components/BrandMark';
import { NotificationBell } from '@/components/NotificationBell';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useHasActiveProcesses } from '@/lib/queries/tasks';

/**
 * Top navigation bar: logo + app name on the left (links back to the
 * landing page), theme toggle and settings dialog on the right. The logo
 * animates only while a task is running or in review.
 */
export function TopNav() {
  const animate = useHasActiveProcesses();
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <Link to="/" aria-label="Go to landing page">
        <BrandMark animate={animate} />
      </Link>

      <div className="flex items-center gap-1">
        <NotificationBell />
        <ThemeToggle />
        <SettingsDialog />
      </div>
    </header>
  );
}
