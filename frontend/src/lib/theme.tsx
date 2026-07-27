import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

/** The user's selectable preference. `'system'` follows the OS. */
export type ThemePreference = 'dark' | 'light' | 'system';
/** The concrete appearance actually applied to the DOM. */
export type EffectiveTheme = 'dark' | 'light';

const STORAGE_KEY = 'lemniscate-theme';
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

interface ThemeContextValue {
  /** The user's stored preference (may be `'system'`). */
  theme: ThemePreference;
  /** The concrete theme applied to the DOM. */
  effectiveTheme: EffectiveTheme;
  setTheme: (theme: ThemePreference) => void;
  /** Cycle system → light → dark → system. */
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

/** Reads the OS-level dark-mode preference; falls back to light. */
export function getSystemTheme(): EffectiveTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia(DARK_MEDIA_QUERY).matches ? 'dark' : 'light';
}

/** Resolves the concrete theme from a preference and the current OS value. */
export function resolveEffectiveTheme(
  preference: ThemePreference,
  systemTheme: EffectiveTheme,
): EffectiveTheme {
  return preference === 'system' ? systemTheme : preference;
}

/** Reads the stored preference, defaulting to `'system'`. */
function readStoredTheme(): ThemePreference {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  return 'system';
}

/** Applies a concrete theme to the document root (single source of truth). */
export function applyTheme(theme: EffectiveTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/**
 * Subscribes to the OS dark-mode preference and re-renders whenever it changes,
 * so a `'system'` preference stays live at runtime.
 */
export function useSystemTheme(): EffectiveTheme {
  const [systemTheme, setSystemTheme] = useState<EffectiveTheme>(getSystemTheme);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(DARK_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? 'dark' : 'light');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return systemTheme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(readStoredTheme);
  const systemTheme = useSystemTheme();
  const effectiveTheme = resolveEffectiveTheme(theme, systemTheme);

  // Persist the preference and apply the resolved theme to the DOM.
  useEffect(() => {
    applyTheme(effectiveTheme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme, effectiveTheme]);

  const setTheme = useCallback((next: ThemePreference) => setThemeState(next), []);
  const cycleTheme = useCallback(() => setThemeState((prev) => NEXT_PREFERENCE[prev]), []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, effectiveTheme, setTheme, cycleTheme }),
    [theme, effectiveTheme, setTheme, cycleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
