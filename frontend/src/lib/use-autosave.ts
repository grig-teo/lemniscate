/**
 * Debounced autosave hook for generated-content editors (proposals, prompts,
 * etc.). Replaces the manual Save-button workflow: the consumer passes the
 * current editable value and a save callback; the hook deep-compares the value
 * to the last-persisted snapshot via JSON, debounces changes, and calls the
 * save callback after an idle period. Pending saves are flushed on unmount so
 * edits are never lost when the user navigates away.
 *
 * Design notes:
 * - Dirty detection uses JSON.stringify (the values are plain JSON-serialisable
 *   objects — strings, arrays, slugs).  This avoids a deep-equal dependency.
 * - onSave is stored in a ref so a new closure (latest component state) is
 *   always used at save time without re-triggering the debounce effect.
 * - Saves are strictly serialized via a promise chain (inFlightRef) so two
 *   PATCH requests can never overlap and race at the backend.
 * - A monotonically increasing sequence number guards the saved-baseline
 *   update as defense-in-depth against any out-of-order completion.
 * - The status resets to 'idle' the moment new unsaved edits arrive, so the
 *   indicator never shows 'Saved'/'Error' while changes are still pending.
 */
import * as React from 'react';

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface UseAutosaveOptions<T> {
  /** Current value; content changes trigger a debounced save (JSON-compared). */
  value: T;
  /** Persist the value. Should throw on failure — the hook tracks the error. */
  onSave: (value: T) => void | Promise<void>;
  /** Idle delay before saving, in milliseconds (default 1000). */
  debounceMs?: number;
  /** When false, no saves fire. Default true. */
  enabled?: boolean;
}

export interface UseAutosaveResult {
  /** Current save lifecycle phase for the status indicator. */
  status: AutosaveStatus;
  /** Last save error (null when status !== 'error'). */
  error: Error | null;
  /** Re-attempt the last failed save (no-op unless status === 'error'). */
  retry: () => void;
  /** Immediately persist pending changes, clearing the debounce timer. */
  flush: () => Promise<void>;
  /** Drop pending changes without saving (e.g. before a Start action). */
  cancel: () => void;
}

const DEFAULT_DEBOUNCE_MS = 1000;

export function useAutosave<T>({
  value,
  onSave,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  enabled = true,
}: UseAutosaveOptions<T>): UseAutosaveResult {
  const [status, setStatus] = React.useState<AutosaveStatus>('idle');
  const [error, setError] = React.useState<Error | null>(null);

  const serializedRef = React.useRef(JSON.stringify(value));
  const pendingValueRef = React.useRef<T | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSeqRef = React.useRef(0);
  const isMountedRef = React.useRef(true);
  // Promise chain for strict save serialization — every save is chained onto
  // the previous so overlapping PATCH requests can never race at the backend.
  const inFlightRef = React.useRef<Promise<void>>(Promise.resolve());

  // Refs updated every render so the debounce effect (which depends only on
  // the serialized content) always uses the freshest callback and value.
  const onSaveRef = React.useRef(onSave);
  const valueRef = React.useRef(value);
  const statusRef = React.useRef(status);
  onSaveRef.current = onSave;
  valueRef.current = value;
  statusRef.current = status;

  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Executes a single save — sets status, awaits onSave, updates the baseline.
  // The sequence guard is defense-in-depth against any out-of-order completion
  // (serialization in performSave makes this a no-op in the normal flow).
  const runSave = React.useCallback(async (snapshot: T): Promise<void> => {
    const seq = ++saveSeqRef.current;
    if (isMountedRef.current) {
      setStatus('saving');
      setError(null);
    }
    try {
      await onSaveRef.current(snapshot);
      if (seq !== saveSeqRef.current) return;
      serializedRef.current = JSON.stringify(snapshot);
      if (pendingValueRef.current === snapshot) pendingValueRef.current = null;
      if (isMountedRef.current) setStatus('saved');
    } catch (err) {
      if (seq !== saveSeqRef.current) return;
      const saveError = err instanceof Error ? err : new Error(String(err));
      if (isMountedRef.current) {
        setError(saveError);
        setStatus('error');
      }
    }
  }, []);

  // Serialize saves: chain behind any in-flight save so two PATCH requests
  // cannot race at the backend (the older one arriving last would overwrite
  // newer data). Runs whether the previous resolved or rejected.
  const performSave = React.useCallback(async (snapshot: T): Promise<void> => {
    const next = inFlightRef.current.then(
      () => runSave(snapshot),
      () => runSave(snapshot),
    );
    inFlightRef.current = next;
    return next;
  }, [runSave]);

  const flush = React.useCallback(async (): Promise<void> => {
    clearTimer();
    const pending = pendingValueRef.current;
    if (pending === null) return;
    await performSave(pending);
  }, [performSave]);

  const retry = React.useCallback((): void => {
    if (status !== 'error') return;
    void flush();
  }, [status, flush]);

  const cancel = React.useCallback((): void => {
    clearTimer();
    pendingValueRef.current = null;
  }, []);

  // Debounced save trigger — reacts only to content changes (serialized form).
  const serialized = JSON.stringify(value);
  React.useEffect(() => {
    if (!enabled) return;

    // Value matches the last-saved snapshot — cancel any pending debounce.
    if (serialized === serializedRef.current) {
      clearTimer();
      pendingValueRef.current = null;
      return;
    }

    // Clear stale terminal status so the indicator reflects pending edits
    // rather than showing 'Saved'/'Error' through the entire debounce window.
    if (isMountedRef.current && (statusRef.current === 'saved' || statusRef.current === 'error')) {
      setStatus('idle');
      setError(null);
    }
    pendingValueRef.current = valueRef.current;
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, debounceMs);
  }, [serialized, enabled, debounceMs, flush]);

  // Flush on unmount; track mount state to suppress post-unmount setState.
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearTimer();
      const pending = pendingValueRef.current;
      if (pending !== null) {
        // Chain through the in-flight promise to preserve serialization even
        // on unmount — prevents an older in-flight save from arriving after
        // this newer unmount save and overwriting it at the backend.
        inFlightRef.current = inFlightRef.current
          .then(() => onSaveRef.current(pending), () => onSaveRef.current(pending))
          .catch(() => {});
      }
    };
  }, []);

  return { status, error, retry, flush, cancel };
}
