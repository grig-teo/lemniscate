// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { LocaleProvider, useLocale } from '@/lib/i18n';
import { LanguageSelect } from '@/components/settings/LanguageSelect';

function Probe() {
  const { locale } = useLocale();
  return <span data-testid="locale">{locale}</span>;
}

describe('LanguageSelect', () => {
  it('switches the active locale and persists it to localStorage', async () => {
    render(
      <LocaleProvider>
        <LanguageSelect />
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('en');

    const select = screen.getByLabelText(/language/i) as HTMLSelectElement;
    select.value = 'ru';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(screen.getByTestId('locale').textContent).toBe('ru');
    expect(localStorage.getItem('lemniscate:locale')).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
  });

  it('labels the selector in the active locale', () => {
    localStorage.setItem('lemniscate:locale', 'zh');
    render(
      <LocaleProvider>
        <LanguageSelect />
      </LocaleProvider>,
    );
    expect(screen.getByLabelText('语言')).toBeTruthy();
  });
});
