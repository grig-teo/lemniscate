import { FormattedMessage, useIntl } from 'react-intl';

import { SUPPORTED_LOCALES, useLocale, type Locale } from '@/lib/i18n';

/** Display name for each locale, in the locale's own language. */
const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  ru: 'Русский',
  zh: '中文',
};

/**
 * Language dropdown for the Settings dialog header. Switches the active
 * locale at runtime via LocaleProvider (persisted to localStorage, mirrored
 * to <html lang>).
 */
export function LanguageSelect() {
  const intl = useIntl();
  const { locale, setLocale } = useLocale();
  const label = intl.formatMessage({ id: 'settings.language', defaultMessage: 'Language' });

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>
        <FormattedMessage id="settings.language" defaultMessage="Language" />
      </span>
      <select
        aria-label={label}
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {SUPPORTED_LOCALES.map((value) => (
          <option key={value} value={value}>
            {LOCALE_NAMES[value]}
          </option>
        ))}
      </select>
    </label>
  );
}
