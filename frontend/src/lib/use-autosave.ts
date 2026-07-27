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
 * - A monotonically increasing sequence number guards the saved-baseline
 *   update so that an older in-flight save completing AFTER a newer save
 *   cannot overwrite the baseline with stale data.
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

  // Refs updated every render so the debounce effect (which depends only on
  // the serialized content) always uses the freshest callback and value.
  const onSaveRef = React.useRef(onSave);
  const valueRef = React.useRef(value);
  onSaveRef.current = onSave;
  valueRef.current = value;

  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const performSave = React.useCallback(async (snapshot: T): Promise<void> => {
    const seq = ++saveSeqRef.current;
    if (isMountedRef.current) {
      setStatus('saving');
      setError(null);
    }
    try {
      await onSaveRef.current(snapshot);
      // Guard against an older save completing after a newer one has started.
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
        Promise.resolve(onSaveRef.current(pending)).catch(() => {});
      }
    };
  }, []);

  return { status, error, retry, flush, cancel };
}
