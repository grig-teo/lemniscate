/**
 * Right-edge rail showing the implementation steps of the selected task as
 * transparent vertical labels, docked to the right edge of the console pane
 * and vertically centered. Steps and tones come from lib/task-steps.ts (the
 * single source of truth). A toggle hides the rail down to a slim show
 * handle; the preference is persisted to localStorage.
 */
import * as React from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';

import { readPersisted, writePersisted } from '@/lib/persist';
import { isRunningStatus } from '@/lib/running-tasks';
import { TASK_STEPS, stepTone, type StepTone, type TaskStep } from '@/lib/task-steps';
import { cn } from '@/lib/utils';

const HIDDEN_STORAGE_KEY = 'lemniscate.task-steps-rail-hidden';

const TONE_STYLES: Record<StepTone, string> = {
  complete: 'text-emerald-600 dark:text-emerald-400',
  current: 'font-semibold text-primary',
  upcoming: 'text-muted-foreground/50',
  failed: 'font-semibold text-destructive',
};

const TOGGLE_CLASSES =
  'flex items-center justify-center rounded-l-md border border-r-0 bg-background/40 ' +
  'px-0.5 py-2 text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground';

/** Hide/show preference persisted to localStorage (best-effort). */
function useRailHidden(status: string): { hidden: boolean; toggle: () => void } {
  const [hidden, setHidden] = React.useState(() => readPersisted(HIDDEN_STORAGE_KEY, false));

  // Opening a live task (queued/running/reviewing code) always opens the
  // right-side steps pane: on the transition into a running status the pane
  // re-shows itself (and clears the persisted hidden preference) so the
  // current step is visible next to the log. The ref starts at a non-running
  // sentinel so that mounting directly into a running status (opening a task
  // that is already in flight) counts as a transition and re-shows the pane.
  const prevStatusRef = React.useRef('');
  React.useEffect(() => {
    const wasRunning = isRunningStatus(prevStatusRef.current);
    prevStatusRef.current = status;
    if (!isRunningStatus(status) || wasRunning) return;
    writePersisted(HIDDEN_STORAGE_KEY, false);
    setHidden(false);
  }, [status]);

  const toggle = React.useCallback(() => {
    setHidden((prev) => {
      writePersisted(HIDDEN_STORAGE_KEY, !prev);
      return !prev;
    });
  }, []);
  return { hidden, toggle };
}

/** One vertical step label with its tone marker. */
function StepItem({ step, tone }: { step: TaskStep; tone: StepTone }) {
  return (
    <li
      data-tone={tone}
      aria-current={tone === 'current' ? 'step' : undefined}
      className={cn('flex flex-col items-center gap-1', TONE_STYLES[tone])}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          tone === 'upcoming' ? 'bg-muted-foreground/30' : 'bg-current',
        )}
      />
      <span className="text-[10px] uppercase tracking-widest [writing-mode:vertical-rl]">
        {step.label}
      </span>
    </li>
  );
}

/** Transparent vertical step list with the hide toggle on its left. */
function RailPanel({ status, onHide }: { status: string; onHide: () => void }) {
  return (
    <div className="flex items-stretch">
      <button type="button" aria-label="Hide implementation steps" onClick={onHide} className={TOGGLE_CLASSES}>
        <PanelRightClose className="h-3.5 w-3.5" aria-hidden />
      </button>
      <ol
        aria-label="Implementation steps"
        className="flex flex-col gap-2.5 rounded-bl-md border-y border-l bg-background/40 px-1.5 py-2 backdrop-blur-sm"
      >
        {TASK_STEPS.map((step, index) => (
          <StepItem key={step.status} step={step} tone={stepTone(index, status)} />
        ))}
      </ol>
    </div>
  );
}

export function TaskStepsRail({ status }: { status: string }) {
  const { hidden, toggle } = useRailHidden(status);
  return (
    <div className="absolute right-0 top-1/2 z-10 -translate-y-1/2">
      {hidden ? (
        <button type="button" aria-label="Show implementation steps" onClick={toggle} className={TOGGLE_CLASSES}>
          <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : (
        <RailPanel status={status} onHide={toggle} />
      )}
    </div>
  );
}
