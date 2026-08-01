/**
 * Shared test helper: wraps rendered components in LocaleProvider so any
 * component under test can use react-intl. Renders in English by default;
 * set localStorage 'lemniscate:locale' before calling to test other locales.
 */
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

import { LocaleProvider } from '@/lib/i18n';

export function renderWithIntl(ui: ReactElement) {
  return render(<LocaleProvider>{ui}</LocaleProvider>);
}
