/**
 * Vertical timeline list for the plan items of a run: each item is a dot on a
 * connecting line (like the right-edge status rail), with the item text shown
 * horizontally next to it. Purely informational — no click targets. Done
 * items are line-through; the first unfinished item is highlighted as the
 * current step.
 */
import * as React from 'react';

import { cn } from '@/lib/utils';

export interface TimelineTodoItem {
  done: boolean;
  text: string;
}

type TodoStatus = 'done' | 'current' | 'pending';

const DOT_STYLES: Record<TodoStatus, string> = {
  done: 'bg-emerald-500',
  current: 'bg-primary',
  pending: 'bg-muted-foreground/30',
};

const TEXT_STYLES: Record<TodoStatus, string> = {
  done: 'text-muted-foreground',
  current: 'font-semibold text-primary',
  pending: 'text-foreground',
};

function itemStatus(item: TimelineTodoItem, firstPendingIndex: number, index: number): TodoStatus {
  if (item.done) return 'done';
  if (index === firstPendingIndex) return 'current';
  return 'pending';
}

/** One timeline row: vertical line segment + dot, horizontal label. */
function TimelineTodoRow({
  item,
  status,
  last,
}: {
  item: TimelineTodoItem;
  status: TodoStatus;
  last: boolean;
}) {
  return (
    <li
      data-status={status}
      className={cn('flex items-stretch gap-2 text-sm', item.done && 'line-through')}
    >
      <span aria-hidden className="flex w-2 shrink-0 flex-col items-center">
        <span data-testid="todo-dot" className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT_STYLES[status])} />
        {!last && (
          <span data-testid="todo-line" className="w-px flex-1 bg-muted-foreground/30" />
        )}
      </span>
      <span className={cn('pb-1.5 leading-snug', TEXT_STYLES[status])}>{item.text}</span>
    </li>
  );
}

export function TimelineTodoList({ items }: { items: TimelineTodoItem[] }): React.ReactElement {
  const firstPendingIndex = items.findIndex((item) => !item.done);
  return (
    <ul aria-label="Plan" className="space-y-0">
      {items.map((item, index) => (
        <TimelineTodoRow
          key={index}
          item={item}
          status={itemStatus(item, firstPendingIndex, index)}
          last={index === items.length - 1}
        />
      ))}
    </ul>
  );
}
