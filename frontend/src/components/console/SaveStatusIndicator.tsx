/**
 * Save-status indicator for the autosave workflow (replaces the manual Save
 * button). Shows a spinner while saving, a checkmark when saved, and a
 * retry button on error. Renders nothing in the idle state (no pending
 * changes, no recent save).
 */
import { AlertCircle, Check, Loader2 } from 'lucide-react';

import type { AutosaveStatus } from '@/lib/use-autosave';

export function SaveStatusIndicator({
  status,
  onRetry,
}: {
  status: AutosaveStatus;
  onRetry: () => void;
}) {
  if (status === 'saving') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Saving…
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Check className="h-3 w-3" aria-hidden />
        Saved
      </span>
    );
  }
  if (status === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1 text-xs text-destructive hover:underline"
      >
        <AlertCircle className="h-3 w-3" aria-hidden />
        Error saving — retry
      </button>
    );
  }
  return null;
}
