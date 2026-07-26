/**
 * Minimal global toast store — no dependency, no context provider.
 *
 * Toasts are transient, user-facing error/notification messages. Any module
 * can `pushToast(message)`; the `<Toasts>` renderer subscribes via
 * `useToasts()` and displays the current list. Each toast auto-dismisses
 * after TOAST_DURATION_MS and can also be dismissed manually.
 */
import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  message: string;
}

/** How long a toast stays visible before auto-dismissing. */
export const TOAST_DURATION_MS = 6_000;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

/** Snapshot for non-React consumers (and tests); identity changes on update. */
export function snapshotToasts(): Toast[] {
  return toasts;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Push a toast; returns its id. Auto-dismisses after TOAST_DURATION_MS. */
export function pushToast(message: string): number {
  const id = nextId++;
  toasts = [...toasts, { id, message }];
  timers.set(
    id,
    setTimeout(() => dismissToast(id), TOAST_DURATION_MS),
  );
  emit();
  return id;
}

/** Remove a toast by id and cancel its pending auto-dismiss timer. */
export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

/** Drop every toast and pending timer (used by tests and on logout). */
export function clearToasts(): void {
  timers.forEach((timer) => clearTimeout(timer));
  timers.clear();
  toasts = [];
  emit();
}

/** React binding: current toast list, re-rendering on every change. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribeToasts, snapshotToasts, snapshotToasts);
}
