import { AlertTriangle, Settings } from 'lucide-react';

import {
  getErrorBannerInfo,
  hasActionableError,
  openSettingsTab,
} from '@/lib/error-codes';
import { Button } from '@/components/ui/button';

/**
 * Prominent error banner shown above the console log when a task fails.
 * Maps the backend errorCode to a user-friendly title + hint and, when a
 * direct fix exists, a button that opens the relevant settings tab.
 */
export function ErrorBanner({ errorCode }: { errorCode: string | null | undefined }) {
  if (!errorCode) return null;
  const info = getErrorBannerInfo(errorCode);
  const actionable = hasActionableError(errorCode);
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-3 border-b border-red-500/20 bg-red-500/5 px-4 py-3"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-red-700 dark:text-red-300">{info.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{info.hint}</p>
      </div>
      {actionable && info.settingsTab && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5 text-xs"
          onClick={() => openSettingsTab(info.settingsTab!)}
        >
          <Settings className="h-3.5 w-3.5" aria-hidden />
          Fix
        </Button>
      )}
    </div>
  );
}
