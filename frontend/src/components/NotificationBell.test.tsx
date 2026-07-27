// @vitest-environment jsdom
/**
 * Locking tests for the notification bell's open/close behavior: the bell
 * toggles the dropdown, an outside mousedown or Escape closes it, clicks
 * inside the panel do not, and clicking a notification still marks it read
 * and closes the panel (pre-existing behavior).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationBell } from '@/components/NotificationBell';
import {
  createTestQueryClient,
  mockFetchSequence,
} from '@/lib/queries/test-helpers';
import { WorkspaceSelectionProvider } from '@/lib/selection';
import type { AppNotification } from '@/lib/notifications';

const EMPTY_LIST = { notifications: [], unreadCount: 0 };

const UNREAD_NOTIFICATION: AppNotification = {
  id: 'n1',
  kind: 'pr_opened',
  title: 'PR opened',
  body: 'agent opened a PR',
  taskId: null,
  prUrl: null,
  readAt: null,
  createdAt: '2026-07-27T10:00:00.000Z',
};

function renderBell() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceSelectionProvider>
        <NotificationBell />
      </WorkspaceSelectionProvider>
    </QueryClientProvider>,
  );
}

function bellButton() {
  return screen.getByRole('button', { name: /^notifications/i });
}

function openDropdown() {
  fireEvent.mouseDown(bellButton());
  fireEvent.click(bellButton());
}

function dropdownVisible(): boolean {
  return screen.queryByText('No notifications yet') !== null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NotificationBell open/close', () => {
  it('opens the dropdown when the bell is clicked', () => {
    mockFetchSequence({ json: EMPTY_LIST });
    renderBell();
    expect(dropdownVisible()).toBe(false);
    openDropdown();
    expect(dropdownVisible()).toBe(true);
  });

  it('closes the dropdown when the bell is clicked again', () => {
    mockFetchSequence({ json: EMPTY_LIST });
    renderBell();
    openDropdown();
    expect(dropdownVisible()).toBe(true);
    fireEvent.mouseDown(bellButton());
    fireEvent.click(bellButton());
    expect(dropdownVisible()).toBe(false);
  });

  it('closes the dropdown on a mousedown outside the bell and panel', () => {
    mockFetchSequence({ json: EMPTY_LIST });
    renderBell();
    openDropdown();
    expect(dropdownVisible()).toBe(true);
    fireEvent.mouseDown(document.body);
    expect(dropdownVisible()).toBe(false);
  });

  it('stays open on a mousedown inside the panel', () => {
    mockFetchSequence({ json: EMPTY_LIST });
    renderBell();
    openDropdown();
    fireEvent.mouseDown(screen.getByText('No notifications yet'));
    expect(dropdownVisible()).toBe(true);
  });

  it('closes the dropdown on Escape', () => {
    mockFetchSequence({ json: EMPTY_LIST });
    renderBell();
    openDropdown();
    expect(dropdownVisible()).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dropdownVisible()).toBe(false);
  });

  it('still marks a notification read and closes when one is clicked', async () => {
    const { calls } = mockFetchSequence(
      { json: { notifications: [UNREAD_NOTIFICATION], unreadCount: 1 } },
      { json: { updated: 1 } },
    );
    renderBell();
    openDropdown();
    const row = await screen.findByRole('button', { name: /agent opened a PR/i });
    fireEvent.click(row);
    await waitFor(() => expect(screen.queryByText('agent opened a PR')).toBeNull());
    expect(calls).toContainEqual({
      url: '/api/notifications/n1/read',
      method: 'POST',
      body: undefined,
    });
  });
});
