// @vitest-environment jsdom
/**
 * Locking tests for the shared useCloseOnOutside hook (extracted from
 * RepoFlagsDropdown, reused by NotificationBell): outside mousedown and
 * Escape close; inside mousedown and other keys do not; listeners are
 * removed on unmount.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCloseOnOutside } from '@/lib/use-close-on-outside';

function Probe({ onClose }: { onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useCloseOnOutside(ref, onClose);
  return (
    <div>
      <div ref={ref}>
        <button type="button">inside</button>
      </div>
      <button type="button">outside</button>
    </div>
  );
}

afterEach(cleanup);

describe('useCloseOnOutside', () => {
  it('calls onClose on a mousedown outside the container', () => {
    const onClose = vi.fn();
    render(<Probe onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose on a mousedown inside the container', () => {
    const onClose = vi.fn();
    render(<Probe onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(<Probe onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const onClose = vi.fn();
    render(<Probe onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes its listeners on unmount', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Probe onClose={onClose} />);
    unmount();
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
