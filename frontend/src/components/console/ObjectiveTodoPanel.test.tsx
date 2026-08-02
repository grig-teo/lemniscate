// @vitest-environment jsdom
/**
 * Locking tests for the ObjectiveTodoPanel: shows the run's objective and a
 * live TODO checklist (done/pending items), hides when empty, and supports a
 * hide/show toggle persisted to localStorage.
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

  it('hides via the toggle and leaves a show handle', () => {
    render(<ObjectiveTodoPanel objective="x" todoItems={ITEMS} />);
    fireEvent.click(screen.getByRole('button', { name: /hide panel/i }));
    // Panel hidden, show-handle visible (the "Plan" button)
    expect(screen.queryByText('Set up project')).toBeNull();
    expect(screen.getByRole('button', { name: /plan/i })).toBeTruthy();
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
