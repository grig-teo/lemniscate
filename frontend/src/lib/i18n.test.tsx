// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { LocaleProvider, useLocale } from '@/lib/i18n';
import en from '@/locales/en.json';
import ru from '@/locales/ru.json';
import zh from '@/locales/zh.json';
import { FormattedMessage } from 'react-intl';

function Probe({ id }: { id: string }) {
  return <FormattedMessage id={id} />;
}

function LocaleName() {
  const { locale } = useLocale();
  return <span data-testid="locale">{locale}</span>;
}

describe('resolveLocale', () => {
  it('resolves stored value → navigator → en and normalizes to base tags', async () => {
    const { resolveLocale } = await import('@/lib/i18n');
    expect(resolveLocale('ru', 'en-US')).toBe('ru');
    expect(resolveLocale(null, 'ru-RU')).toBe('ru');
    expect(resolveLocale(null, 'zh-Hans-CN')).toBe('zh');
    expect(resolveLocale(null, 'fr-FR')).toBe('en');
    expect(resolveLocale('fr', null)).toBe('en');
    expect(resolveLocale(null, null)).toBe('en');
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('LocaleProvider', () => {
  it('renders the English message by default', () => {
    render(
      <LocaleProvider>
        <Probe id="login.tagline" />
      </LocaleProvider>,
    );
    expect(screen.getByText(en['login.tagline'])).toBeTruthy();
  });

  it('renders the stored Russian locale', () => {
    localStorage.setItem('lemniscate:locale', 'ru');
    render(
      <LocaleProvider>
        <Probe id="login.tagline" />
      </LocaleProvider>,
    );
    expect(screen.getByText(ru['login.tagline'])).toBeTruthy();
  });

  it('renders the stored Chinese locale', () => {
    localStorage.setItem('lemniscate:locale', 'zh');
    render(
      <LocaleProvider>
        <Probe id="login.tagline" />
      </LocaleProvider>,
    );
    expect(screen.getByText(zh['login.tagline'])).toBeTruthy();
  });

  it('re-renders when the locale changes at runtime and persists the choice', () => {
    function Switcher() {
      const { setLocale } = useLocale();
      return (
        <button type="button" onClick={() => setLocale('ru')}>
          switch
        </button>
      );
    }
    render(
      <LocaleProvider>
        <Probe id="login.tagline" />
        <LocaleName />
        <Switcher />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('en');
    screen.getByText('switch').click();
    expect(screen.getByText(ru['login.tagline'])).toBeTruthy();
    expect(localStorage.getItem('lemniscate:locale')).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
  });

  it('falls back to the English message when a translation is missing', () => {
    localStorage.setItem('lemniscate:locale', 'ru');
    render(
      <LocaleProvider>
        <span data-testid="missing">
          <FormattedMessage id="test.only-in-en" defaultMessage="Only in English" />
        </span>
      </LocaleProvider>,
    );
    expect(screen.getByTestId('missing').textContent).toBe('Only in English');
  });
});
