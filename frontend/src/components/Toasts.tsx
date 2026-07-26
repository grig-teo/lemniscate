import { X } from 'lucide-react';

import { dismissToast, useToasts } from '@/lib/toasts';

/**
 * Fixed bottom-right stack of transient error toasts. Mounted once in
 * `main.tsx` so every page (landing, login, dashboard) can surface messages.
 */
export function Toasts() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          className="pointer-events-auto flex items-start gap-2 rounded-md border border-destructive/40 bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg"
        >
          <p className="min-w-0 flex-1 break-words">{toast.message}</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
