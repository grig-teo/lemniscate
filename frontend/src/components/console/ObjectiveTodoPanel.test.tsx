// @vitest-environment jsdom
/**
 * Locking tests for the ObjectiveTodoPanel: shows the run's objective and a
 * live TODO checklist (done/pending items), hides when empty, and supports a
 * hide/show toggle persisted to localStorage. When hidden, only a small
 * icon-only show handle remains on the right edge (no "Plan" label).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObjectiveTodoPanel } from '@/components/console/ObjectiveTodoPanel';

afterEach(() => cleanup());
beforeEach(() => window.localStorage.clear());

const ITEMS = [
  { done: true, text: 'Set up project' },
  { done: false, text: 'Write tests' },
  { done: false, text: 'Deploy' },
];

describe('ObjectiveTodoPanel', () => {
  it('renders nothing when both objective and todoItems are empty', () => {
    const { container } = render(<ObjectiveTodoPanel objective={null} todoItems={[]} />);
    expect(container.children).toHaveLength(0);
  });

  it('shows the objective text', () => {
    render(<ObjectiveTodoPanel objective="Implement the login feature end-to-end" todoItems={[]} />);
    expect(screen.getByText('Implement the login feature end-to-end')).toBeTruthy();
    expect(screen.getByText('Objective')).toBeTruthy();
  });

  it('renders the TODO checklist with done/pending items', () => {
    render(<ObjectiveTodoPanel objective="x" todoItems={ITEMS} />);
    expect(screen.getByText('Set up project')).toBeTruthy();
    expect(screen.getByText('Write tests')).toBeTruthy();
    expect(screen.getByText('Deploy')).toBeTruthy();
    // Progress count: 1/3
    expect(screen.getByText('1/3')).toBeTruthy();
  });

  it('marks done items with a line-through', () => {
    render(<ObjectiveTodoPanel objective="x" todoItems={ITEMS} />);
    const doneLi = screen.getByText('Set up project').closest('li')!;
    expect(doneLi.className).toContain('line-through');
    const pendingLi = screen.getByText('Write tests').closest('li')!;
    expect(pendingLi.className).not.toContain('line-through');
  });

  it('shows green progress when all items are done', () => {
    render(
      <ObjectiveTodoPanel
        objective="x"
        todoItems={[{ done: true, text: 'A' }, { done: true, text: 'B' }]}
      />,
    );
    expect(screen.getByText('2/2')).toBeTruthy();
    expect(screen.getByText('2/2').className).toContain('emerald');
  });

  it('hides via the toggle and leaves an icon-only show handle (no "Plan" label)', () => {
    render(<ObjectiveTodoPanel objective="x" todoItems={ITEMS} />);
    fireEvent.click(screen.getByRole('button', { name: /hide panel/i }));
    // Panel hidden; a small show handle remains, but without the "Plan" label.
    expect(screen.queryByText('Set up project')).toBeNull();
    expect(screen.queryByText('Plan')).toBeNull();
    const handle = screen.getByRole('button', { name: /show objective & todo/i });
    expect(handle.textContent).not.toContain('Plan');
  });

  it('docks the hidden show-handle flush to the right edge like the status-line rail', () => {
    render(<ObjectiveTodoPanel objective="x" todoItems={ITEMS} />);
    fireEvent.click(screen.getByRole('button', { name: /hide panel/i }));
    const handle = screen.getByRole('button', { name: /show objective & todo/i });
    const classes = handle.className;
    // Flush to the right edge (not inset), rounded only on the left, and with
    // no right border — mirroring the TaskStepsRail edge-docked show handle.
    expect(classes).toContain('right-0');
    expect(classes).not.toContain('right-3');
    expect(classes).toContain('rounded-l');
    expect(classes).toContain('border-r-0');
  });

  it('restores the panel via the show handle', () => {
    render(<ObjectiveTodoPanel objective="x" todoItems={ITEMS} />);
    fireEvent.click(screen.getByRole('button', { name: /hide panel/i }));
    expect(screen.queryByText('Set up project')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show objective & todo/i }));
    expect(screen.getByText('Set up project')).toBeTruthy();
    expect(window.localStorage.getItem('lemniscate.objective-todo-hidden')).toBe('false');
  });

  it('collapses content via the chevron without hiding the panel', () => {
    render(<ObjectiveTodoPanel objective="x" todoItems={ITEMS} />);
    fireEvent.click(screen.getByRole('button', { name: /collapse/i }));
    // Header still visible, content hidden
    expect(screen.getByText('Objective & Plan')).toBeTruthy();
    expect(screen.queryByText('Set up project')).toBeNull();
  });

  it('persists the hidden state to localStorage', () => {
    render(<ObjectiveTodoPanel objective="x" todoItems={ITEMS} />);
    fireEvent.click(screen.getByRole('button', { name: /hide panel/i }));
    expect(window.localStorage.getItem('lemniscate.objective-todo-hidden')).toBe('true');
  });
});
