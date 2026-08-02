// @vitest-environment jsdom
/**
 * Tests for TimelineTodoList: the plan items render as a vertical timeline —
 * a dot marker per item connected by a line (like the status rail), with no
 * check-mark boxes, done items line-through, the next unfinished item
 * highlighted, and the list purely informational (not interactive).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TimelineTodoList, type TimelineTodoItem } from '@/components/console/TimelineTodoList';

afterEach(() => cleanup());

const ITEMS: TimelineTodoItem[] = [
  { done: true, text: 'Set up project' },
  { done: false, text: 'Write tests' },
  { done: false, text: 'Deploy' },
];

describe('TimelineTodoList', () => {
  it('renders every item as a labeled list entry with a timeline dot', () => {
    render(<TimelineTodoList items={ITEMS} />);
    const list = screen.getByRole('list', { name: /plan/i });
    expect(list.querySelectorAll('li')).toHaveLength(3);
    for (const item of ITEMS) {
      const row = screen.getByText(item.text).closest('li')!;
      expect(row.querySelector('[data-testid="todo-dot"]')).toBeTruthy();
    }
  });

  it('connects the dots with a vertical line segment between items', () => {
    render(<TimelineTodoList items={ITEMS} />);
    const list = screen.getByRole('list', { name: /plan/i });
    // One line per gap; the last item has nothing below to connect to.
    expect(list.querySelectorAll('[data-testid="todo-line"]')).toHaveLength(2);
  });

  it('uses no check-mark icon or check box anywhere', () => {
    const { container } = render(<TimelineTodoList items={ITEMS} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
  });

  it('keeps done items line-through and marks them as done', () => {
    render(<TimelineTodoList items={ITEMS} />);
    const doneRow = screen.getByText('Set up project').closest('li')!;
    expect(doneRow.dataset.status).toBe('done');
    expect(doneRow.className).toContain('line-through');
    const pendingRow = screen.getByText('Write tests').closest('li')!;
    expect(pendingRow.className).not.toContain('line-through');
  });

  it('highlights the first unfinished item as the current step', () => {
    render(<TimelineTodoList items={ITEMS} />);
    expect(screen.getByText('Write tests').closest('li')!.dataset.status).toBe('current');
    expect(screen.getByText('Deploy').closest('li')!.dataset.status).toBe('pending');
  });

  it('marks every item done (no current step) when all are finished', () => {
    render(
      <TimelineTodoList
        items={[
          { done: true, text: 'A' },
          { done: true, text: 'B' },
        ]}
      />,
    );
    expect(screen.getByText('A').closest('li')!.dataset.status).toBe('done');
    expect(screen.getByText('B').closest('li')!.dataset.status).toBe('done');
  });

  it('is not interactive: no buttons, links, or clickable rows', () => {
    const { container } = render(<TimelineTodoList items={ITEMS} />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText('Deploy').closest('li')!.className).not.toContain('cursor-pointer');
  });
});
