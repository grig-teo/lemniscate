import { Infinity as InfinityIcon } from 'lucide-react';

import { SettingsDialog } from '@/components/settings/SettingsDialog';

/**
 * Top navigation bar: logo + app name on the left, settings dialog on the right.
 */
export function TopNav() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2">
        <InfinityIcon className="h-6 w-6 text-foreground" aria-hidden />
        <span className="text-lg font-semibold tracking-tight">Lemniscate</span>
      </div>

      <SettingsDialog />
    </header>
  );
}
