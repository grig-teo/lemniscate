// @vitest-environment jsdom
/**
 * Locking tests for TaskTitle: the truncated label shows the full task title
 * in a styled tooltip on hover/focus, replacing the sluggish native `title`
 * attribute used by the left-pane proposal/prompt/archived lists.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskTitle } from '@/components/repo-tree/TaskTitle';

afterEach(() => {
  cleanup();
});

describe('TaskTitle', () => {
  it('renders the title text in the truncated label', () => {
    render(<TaskTitle title="Refactor the auth module" />);

    expect(screen.getByText('Refactor the auth module')).toBeTruthy();
  });

  it('does not leak the native title attribute (no double tooltip)', () => {
    const { container } = render(<TaskTitle title="Refactor the auth module" />);

    expect(container.querySelector('[title]')).toBeNull();
  });

  it('shows the full title in a tooltip on focus', async () => {
    const longTitle = 'A very long proposal title that does not fit the sidebar width and should be revealed in full on hover';
    render(<TaskTitle title={longTitle} />);
    fireEvent.focus(screen.getByText(longTitle));

    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeTruthy();
    });
    expect(screen.getByRole('tooltip').textContent).toBe(longTitle);
  });
});
