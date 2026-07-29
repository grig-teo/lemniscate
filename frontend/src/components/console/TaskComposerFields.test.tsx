// @vitest-environment jsdom
/**
 * Locking tests for the composer's secondary "save for later" action: it is
 * an icon-button (no visible text label) that parks the prompt as a pending
 * task, keeps its accessible name for screen readers, and respects the
 * disabled state while a task is being created.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SaveLaterButton } from '@/components/console/TaskComposerFields';

// vitest runs with globals:false, so testing-library's auto-cleanup is not
// registered; unmount explicitly between tests.
afterEach(() => cleanup());

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save prompt for later' }) as HTMLButtonElement;
}

describe('SaveLaterButton', () => {
  it('renders as an icon-button without a visible text label', () => {
    render(<SaveLaterButton canSave pending={false} onClick={() => {}} />);

    const button = saveButton();
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.textContent).toBe('');
    expect(screen.queryByText('Save for later')).toBeNull();
  });

  it('invokes onClick when the prompt can be saved', () => {
    const onClick = vi.fn();
    render(<SaveLaterButton canSave pending={false} onClick={onClick} />);

    fireEvent.click(saveButton());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is disabled when the prompt cannot be saved', () => {
    render(<SaveLaterButton canSave={false} pending={false} onClick={() => {}} />);

    expect(saveButton().disabled).toBe(true);
  });

  it('is disabled while a task is being created', () => {
    render(<SaveLaterButton canSave pending onClick={() => {}} />);

    expect(saveButton().disabled).toBe(true);
  });
});
