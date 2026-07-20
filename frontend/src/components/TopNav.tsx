import { Infinity as InfinityIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { ThemeToggle } from '@/components/ThemeToggle';

/**
 * Top navigation bar: logo + app name on the left (links back to the
 * landing page), theme toggle and settings dialog on the right.
 */
export function TopNav() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <Link to="/" className="flex items-center gap-2" aria-label="Go to landing page">
        <InfinityIcon className="h-6 w-6 text-foreground" aria-hidden />
        <span className="text-lg font-semibold tracking-tight">Lemniscate</span>
      </Link>

      <div className="flex items-center gap-1">
        <ThemeToggle />
        <SettingsDialog />
      </div>
    </header>
  );
}
