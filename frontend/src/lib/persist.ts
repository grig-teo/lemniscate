/**
 * Single home for localStorage-backed UI state (selected task, sidebar tree
 * expansion, collapsed connection groups). All reads go through a try/catch
 * JSON parse so a corrupted value falls back instead of breaking the app.
 */

/** Parse a stored JSON value; any failure (missing, invalid) yields the fallback. */
export function readStoredJson<T>(
  storage: Pick<Storage, 'getItem'> | null,
  key: string,
  fallback: T,
): T {
  try {
    const raw = storage?.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Serialize a value; storage failures (quota, denied) are non-fatal. */
export function writeStoredJson(
  storage: Pick<Storage, 'setItem'> | null,
  key: string,
  value: unknown,
): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — UI state persistence is best-effort */
  }
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

/** readStoredJson bound to window.localStorage. */
export function readPersisted<T>(key: string, fallback: T): T {
  return readStoredJson(getStorage(), key, fallback);
}

/** writeStoredJson bound to window.localStorage. */
export function writePersisted(key: string, value: unknown): void {
  writeStoredJson(getStorage(), key, value);
}
