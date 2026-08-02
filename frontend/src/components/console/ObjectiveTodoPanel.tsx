/**
 * Right-top panel showing the run's Objective (the task goal the agent is
 * tracking) and a live TODO checklist (from the agent's todo_write calls).
 * Hidden when both are empty. Hiding via the close button removes the panel
 * entirely (no "Plan" show handle or icon is left on the right edge); the
 * preference is persisted to localStorage (same pattern as TaskStepsRail),
 * so clearing it brings the panel back.
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
  const { hidden, hide } = usePanelHidden();
  const [collapsed, setCollapsed] = React.useState(false);

  // Nothing to show — render nothing (no empty panel).
  if (!objective && todoItems.length === 0) return null;

  const doneCount = todoItems.filter((i) => i.done).length;
  const allDone = todoItems.length > 0 && doneCount === todoItems.length;

  // Hidden: render nothing — no Plan show handle or icon on the right edge.
  if (hidden) return null;

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
            onClick={hide}
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
              <div className="mb-1 flex items-center justify-between text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                <span>Plan</span>
                <span className={allDone ? 'text-emerald-600 dark:text-emerald-400' : undefined}>
                  {doneCount}/{todoItems.length}
                </span>
              </div>
              <ul className="space-y-1">
                {todoItems.map((item, i) => (
                  <li
                    key={`${i}-${item.text}`}
                    className={cn(
                      'flex items-start gap-1.5 text-sm leading-snug',
                      item.done ? 'text-muted-foreground line-through' : 'text-foreground',
                    )}
                  >
                    <span className="mt-0.5 shrink-0">
                      {item.done ? (
                        <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <span className="block size-3.5 rounded-sm border border-muted-foreground/40" />
                      )}
                    </span>
                    <span>{item.text}</span>
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

/** Hide preference persisted to localStorage (best-effort). */
function usePanelHidden(): { hidden: boolean; hide: () => void } {
  const [hidden, setHidden] = React.useState(() => readPersisted(HIDDEN_STORAGE_KEY, false));
  const hide = React.useCallback(() => {
    writePersisted(HIDDEN_STORAGE_KEY, true);
    setHidden(true);
  }, []);
  return { hidden, hide };
}
