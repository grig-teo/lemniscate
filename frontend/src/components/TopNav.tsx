import { Link } from 'react-router-dom';

import { BrandMark } from '@/components/BrandMark';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { ThemeToggle } from '@/components/ThemeToggle';

/**
 * Top navigation bar: logo + app name on the left (links back to the
 * landing page), theme toggle and settings dialog on the right.
 */
export function TopNav() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <Link to="/" aria-label="Go to landing page">
        <BrandMark />
      </Link>

      <div className="flex items-center gap-1">
        <ThemeToggle />
        <SettingsDialog />
      </div>
    </header>
  );
}
