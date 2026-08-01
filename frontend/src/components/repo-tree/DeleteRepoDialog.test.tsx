// @vitest-environment jsdom
/**
 * Tests for the repository deletion flow: the settings dropdown exposes a
 * "Delete repository" action, which opens the "Do you really want to delete"
 * dialog; Yes issues DELETE /api/repositories/:id, No closes without a call.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RepoFlagsDropdown } from '@/components/repo-tree/RepoFlagsDropdown';
import { WorkspaceSelectionProvider } from '@/lib/selection';
import { createTestQueryClient, mockFetchSequence } from '@/lib/queries/test-helpers';
import type { Repository } from '@/lib/hooks';

const repo = {
  id: 'r1',
  name: 'app',
  fullName: 'octo/app',
  autoCreatePr: false,
  autoReviewPr: false,
  autoMergePr: false,
  autoAddressReview: false,
  autoRunProposals: false,
  connection: { provider: 'github', username: 'octo' },
} as unknown as Repository;

function renderDropdown(queryClient = createTestQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceSelectionProvider>
        <RepoFlagsDropdown repo={repo} onClose={() => undefined} />
      </WorkspaceSelectionProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RepoFlagsDropdown delete action', () => {
  it('shows a Delete repository button in the settings menu', () => {
    renderDropdown();
    expect(screen.getByRole('button', { name: /delete repository/i })).toBeTruthy();
  });

  it('asks for confirmation and Yes issues the DELETE request', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['repositories'], [repo]);
    const { calls } = mockFetchSequence({ status: 204 });
    renderDropdown(queryClient);

    fireEvent.click(screen.getByRole('button', { name: /delete repository/i }));
    expect(screen.getByText(/do you really want to delete/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() =>
      expect(calls).toEqual([
        { url: '/api/repositories/r1', method: 'DELETE', body: undefined },
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByText(/do you really want to delete/i)).toBeNull(),
    );
  });

  it('No closes the dialog without calling the API', () => {
    const { calls } = mockFetchSequence({ status: 204 });
    renderDropdown();

    fireEvent.click(screen.getByRole('button', { name: /delete repository/i }));
    fireEvent.click(screen.getByRole('button', { name: 'No' }));

    expect(screen.queryByText(/do you really want to delete/i)).toBeNull();
    expect(calls).toEqual([]);
  });
});
