// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { useGitlemRepos } from '@/lib/queries/gitlem';

// Locks the gitlem repos filtering: useGitlemRepos() returns only repositories
// whose connection provider is 'gitlem' from the shared repository list.
const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => mocks.apiGet(...a) } }));

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// A small sink component to read the hook result.
function Sink() {
  const repos = useGitlemRepos();
  return (
    <ul data-testid="list">
      {repos.data?.map((r) => (
        <li key={r.id}>{r.name}</li>
      ))}
    </ul>
  );
}

describe('useGitlemRepos', () => {
  beforeEach(() => {
    mocks.apiGet.mockImplementation((url: string) => {
      if (url === '/api/repositories') {
        return Promise.resolve({
          repositories: [
            { id: '1', name: 'gitlem-one', connection: { provider: 'gitlem', username: 'me' } },
            { id: '2', name: 'github-one', connection: { provider: 'github', username: 'me' } },
            { id: '3', name: 'gitlem-two', connection: { provider: 'gitlem', username: 'me' } },
          ],
        });
      }
      return Promise.resolve({});
    });
  });

  it('filters the repository list to gitlem connections only', async () => {
    wrap(<Sink />);
    const items = await screen.findByTestId('list');
    // wait for the query to settle, then assert only the two gitlem repos render
    expect(await screen.findByText('gitlem-one')).toBeTruthy();
    expect(screen.getByText('gitlem-two')).toBeTruthy();
    expect(screen.queryByText('github-one')).toBeNull();
    expect(items.children.length).toBe(2);
  });
});
