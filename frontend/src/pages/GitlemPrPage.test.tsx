// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitlemPrPage } from '@/pages/GitlemPrPage';

// Locks the standalone gitlem PR page: it fetches /api/gitlem/repos/:name/prs/:number
// and renders the PR state, branches and changed-files list; a 404 renders the
// not-found state instead of crashing (the original "404 Not Found" report).
const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => mocks.apiGet(...a) } }));

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/gitlem/repos/:owner/:repo/pulls/:number" element={<GitlemPrPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GitlemPrPage', () => {
  beforeEach(() => {
    mocks.apiGet.mockReset();
  });

  it('renders the PR details and changed files', async () => {
    mocks.apiGet.mockResolvedValue({
      pr: {
        number: 1,
        title: 'feat: add thing',
        body: 'does the thing',
        head: 'lem/feature',
        base: 'main',
        state: 'open',
        createdAt: '2026-08-01T10:00:00.000Z',
        repo: 'alice/demo',
      },
      files: [{ path: 'src/thing.ts', status: 'added', headLines: 12, baseLines: 0 }],
    });
    renderPage('/gitlem/repos/alice/demo/pulls/1');
    expect(mocks.apiGet).toHaveBeenCalledWith('/api/gitlem/repos/demo/prs/1');
    expect(await screen.findByText('feat: add thing')).toBeTruthy();
    expect(screen.getByText('open')).toBeTruthy();
    expect(screen.getByText('lem/feature')).toBeTruthy();
    expect(screen.getByText('src/thing.ts')).toBeTruthy();
    expect(screen.getByText('does the thing')).toBeTruthy();
  });

  it('shows a not-found state when the PR does not exist', async () => {
    mocks.apiGet.mockRejectedValue(new Error('404'));
    renderPage('/gitlem/repos/alice/demo/pulls/99');
    expect(await screen.findByText('Pull request not found.')).toBeTruthy();
  });
});
