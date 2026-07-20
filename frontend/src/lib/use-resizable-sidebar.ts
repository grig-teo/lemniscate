import * as React from 'react';

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 288; // matches the previous fixed w-72
export const SIDEBAR_WIDTH_STORAGE_KEY = 'lemniscate.sidebar-width';

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function readStoredSidebarWidth(storage: Pick<Storage, 'getItem'> | null): number {
  const raw = storage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  if (raw == null) return SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(Number(raw));
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

/** Attaches window drag listeners; returns a cleanup that removes them. */
function beginDrag(startX: number, startWidth: number, onWidth: (width: number) => void) {
  const onMove = (event: MouseEvent) =>
    onWidth(clampSidebarWidth(startWidth + event.clientX - startX));
  const stop = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', stop);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', stop);
  return stop;
}

/**
 * Resizable left sidebar width: live drag updates between
 * SIDEBAR_MIN_WIDTH..SIDEBAR_MAX_WIDTH, persisted to localStorage
 * and restored on load. Listeners are cleaned up on mouseup/unmount.
 */
export function useResizableSidebar() {
  const [width, setWidth] = React.useState(() => readStoredSidebarWidth(getStorage()));
  const widthRef = React.useRef(width);
  const stopDragRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    widthRef.current = width;
    getStorage()?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  }, [width]);

  React.useEffect(() => () => stopDragRef.current?.(), []);

  const startDrag = React.useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    stopDragRef.current?.();
    stopDragRef.current = beginDrag(event.clientX, widthRef.current, setWidth);
  }, []);

  return { width, startDrag };
}
