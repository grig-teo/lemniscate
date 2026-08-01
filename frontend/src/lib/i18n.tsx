/**
 * i18n infrastructure: locale resolution, the <LocaleProvider> wrapper
 * around react-intl's IntlProvider, and the useLocale() hook used by the
 * Settings language selector.
 *
 * Resolution order: localStorage('lemniscate:locale') → navigator.language
 * → 'en'. Catalogs are statically imported so every supported locale ships
 * in the main bundle (the app has only 3 locales and the catalogs are tiny).
 * Unmigrated components keep rendering their inline English strings while
 * translated ones use <FormattedMessage>/intl.formatMessage.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { IntlProvider } from 'react-intl';

import en from '@/locales/en.json';
import ru from '@/locales/ru.json';
import zh from '@/locales/zh.json';

export const SUPPORTED_LOCALES = ['en', 'ru', 'zh'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_STORAGE_KEY = 'lemniscate:locale';
export const DEFAULT_LOCALE: Locale = 'en';

const MESSAGES: Record<Locale, Record<string, string>> = { en, ru, zh };

/** Maps a raw BCP-47 tag ('ru-RU', 'zh-Hans-CN') to a supported base locale. */
function normalizeLocale(raw: string): Locale | null {
  const base = raw.toLowerCase().split('-')[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? (base as Locale) : null;
}

/**
 * Resolves the active locale: a valid stored preference wins, then the
 * browser language, then English. Unknown/empty values are ignored.
 */
export function resolveLocale(
  stored: string | null,
  navigatorLanguage: string | null,
): Locale {
  const fromStorage = stored ? normalizeLocale(stored) : null;
  if (fromStorage) return fromStorage;
  const fromNavigator = navigatorLanguage ? normalizeLocale(navigatorLanguage) : null;
  return fromNavigator ?? DEFAULT_LOCALE;
}

function readInitialLocale(): Locale {
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(LOCALE_STORAGE_KEY);
  const nav = typeof navigator === 'undefined' ? null : navigator.language;
  return resolveLocale(stored, nav);
}

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * Wraps the app in react-intl's IntlProvider with the resolved locale and
 * its message catalog. Persists explicit choices, keeps <html lang> in
 * sync, and re-renders on runtime locale switches.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
    setLocaleState(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<LocaleContextValue>(() => ({ locale, setLocale }), [locale, setLocale]);

  return (
    <LocaleContext.Provider value={value}>
      <IntlProvider locale={locale} messages={MESSAGES[locale]} defaultLocale={DEFAULT_LOCALE}>
        {children}
      </IntlProvider>
    </LocaleContext.Provider>
  );
}

/** Active locale + setter; throws outside LocaleProvider (mirrors useTheme). */
export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider');
  return ctx;
}
