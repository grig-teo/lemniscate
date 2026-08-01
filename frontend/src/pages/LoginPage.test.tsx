// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { api } from '@/lib/api';
import { LocaleProvider } from '@/lib/i18n';
import { LoginPage } from '@/pages/LoginPage';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
}));

function renderLogin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <MemoryRouter initialEntries={['/login']}>
          <LoginPage />
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('LoginPage i18n', () => {
  it('renders the English login copy by default', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('unauthorized'));
    renderLogin();
    expect(await screen.findByText('Connect a git host to get started.')).toBeTruthy();
  });

  it('renders the Russian login copy when the stored locale is ru', async () => {
    localStorage.setItem('lemniscate:locale', 'ru');
    vi.mocked(api.get).mockRejectedValue(new Error('unauthorized'));
    renderLogin();
    screen.debug(undefined, 20000);
    expect(
      await screen.findByText('Подключите git-хостинг, чтобы начать работу.'),
    ).toBeTruthy();
  });

  it('renders the Chinese login copy when the stored locale is zh', async () => {
    localStorage.setItem('lemniscate:locale', 'zh');
    vi.mocked(api.get).mockRejectedValue(new Error('unauthorized'));
    renderLogin();
    expect(await screen.findByText('连接一个 git 托管平台即可开始使用。')).toBeTruthy();
  });
});
