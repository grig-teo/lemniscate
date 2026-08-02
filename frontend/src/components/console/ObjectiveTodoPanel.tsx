/**
 * Right-top panel showing the run's Objective (the task goal the agent is
 * tracking) and a live TODO checklist (from the agent's todo_write calls).
 * Hidden when both are empty. A hide/show toggle is persisted to localStorage
 * (same pattern as TaskStepsRail).
 *
 * Data flows from the backend: the lemcore loop emits agent_step events with
 * subtype:'objective' (when the model restates its goal) and subtype:'todo'
 * (on every todo_write, with parsed items in `detail`). useTaskConsole derives
 * the latest of each.
 */
import * as React from 'react';
import { Check, ChevronDown, ChevronUp, ListTodo, Target, X } from 'lucide-react';

import { readPersisted, writePersisted } from '@/lib/persist';
import { cn } from '@/lib/utils';

const HIDDEN_STORAGE_KEY = 'lemniscate.objective-todo-hidden';

export interface TodoItem {
  done: boolean;
  text: string;
}

export interface ObjectiveTodoPanelProps {
  objective: string | null;
  todoItems: TodoItem[];
}

export function ObjectiveTodoPanel({ objective, todoItems }: ObjectiveTodoPanelProps): React.ReactElement | null {
  const { hidden, toggle } = usePanelHidden();
  const [collapsed, setCollapsed] = React.useState(false);

  // Nothing to show — render nothing (no empty panel).
  if (!objective && todoItems.length === 0) return null;

  const doneCount = todoItems.filter((i) => i.done).length;
  const allDone = todoItems.length > 0 && doneCount === todoItems.length;

  if (hidden) {
    return (
      <button
        type="button"
        onClick={toggle}
        title="Show objective & TODO"
        className={cn(
          'absolute right-3 top-16 z-20 flex items-center gap-1 rounded-lg border bg-background/80 px-2 py-1.5',
          'text-xs text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:text-foreground',
        )}
      >
        <ListTodo className="size-3.5" />
        <span>Plan</span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        'absolute right-3 top-16 z-20 flex max-h-[60vh] w-72 flex-col overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur-sm',
        'animate-in fade-in slide-in-from-top-2 duration-150',
      )}
    >
      {/* Header: title + collapse/close */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <ListTodo className="size-3.5 text-primary" />
          <span>Objective & Plan</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Expand' : 'Collapse'}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={toggle}
            title="Hide panel"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="flex-1 overflow-y-auto px-3 py-2.5">
          {/* Objective */}
          {objective && (
            <div className="mb-3">
              <div className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                <Target className="size-3" />
                <span>Objective</span>
              </div>
              <p className="text-sm leading-snug text-foreground">{objective}</p>
            </div>
          )}

          {/* TODO checklist */}
          {todoItems.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                <span>Progress</span>
                <span className={cn('tabular-nums', allDone && 'text-emerald-500')}>
                  {doneCount}/{todoItems.length}
                </span>
              </div>
              {/* Progress bar */}
              <div className="mb-2.5 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-300',
                    allDone ? 'bg-emerald-500' : 'bg-primary',
                  )}
                  style={{ width: `${todoItems.length > 0 ? (doneCount / todoItems.length) * 100 : 0}%` }}
                />
              </div>
              <ul className="space-y-1">
                {todoItems.map((item, i) => (
                  <li
                    key={i}
                    className={cn(
                      'flex items-start gap-2 rounded-md px-1.5 py-1 text-sm transition-colors',
                      item.done ? 'text-muted-foreground line-through' : 'text-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                        item.done
                          ? 'border-emerald-500 bg-emerald-500 text-white'
                          : 'border-muted-foreground/40',
                      )}
                    >
                      {item.done && <Check className="size-3" />}
                    </span>
                    <span className="leading-snug">{item.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function usePanelHidden(): { hidden: boolean; toggle: () => void } {
  const [hidden, setHidden] = React.useState<boolean>(() => readPersisted(HIDDEN_STORAGE_KEY, false));
  const toggle = React.useCallback(() => {
    setHidden((prev) => {
      const next = !prev;
      writePersisted(HIDDEN_STORAGE_KEY, next);
      return next;
    });
  }, []);
  return { hidden, toggle };
}
