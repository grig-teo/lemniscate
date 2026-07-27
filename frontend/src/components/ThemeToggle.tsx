import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useTheme } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';

/** Tooltip/aria text shown for each current preference (describes the next). */
const NEXT_LABEL: Record<ThemePreference, string> = {
  system: 'Switch to light theme',
  light: 'Switch to dark theme',
  dark: 'Switch to system theme',
};

/** Icon representing the active preference (not the resolved appearance). */
const ICON = {
  system: Monitor,
  light: Sun,
  dark: Moon,
} as const;

/**
 * Theme switch shown in the top navigation. Cycles
 * System → Light → Dark → System so the toggle keeps a single icon footprint
 * while exposing the OS-following "system" mode.
 */
export function ThemeToggle() {
  const { theme, cycleTheme } = useTheme();
  const label = NEXT_LABEL[theme];
  const Icon = ICON[theme];

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={cycleTheme} aria-label={label}>
            <Icon className="h-5 w-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
