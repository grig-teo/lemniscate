import * as React from 'react';
import { Check, ChevronUp, Loader2 } from 'lucide-react';

import { useLlmConfigs, useSwitchTaskModel, type LlmConfig, type Task } from '@/lib/hooks';
import { pushToast } from '@/lib/toasts';
import { useCloseOnOutside } from '@/lib/use-close-on-outside';
import { cn } from '@/lib/utils';

/** Footer label: the config currently implementing the task. */
function currentLabel(task: Task): string {
  if (task.llmConfigName && task.llmModel) return `${task.llmConfigName} · ${task.llmModel}`;
  return task.llmModel ?? task.llmConfigName ?? 'Select model';
}

function ModelMenuItem({
  config,
  active,
  onChoose,
}: {
  config: LlmConfig;
  active: boolean;
  onChoose: (config: LlmConfig) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
        onClick={() => onChoose(config)}
      >
        <Check
          className={cn('h-3 w-3 shrink-0', active ? 'opacity-100' : 'opacity-0')}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">
          {config.name} · <span className="text-muted-foreground">{config.model}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * Active-model dropdown of the console footer: shows the LLM currently
 * implementing the task and switches it MID-RUN on selection — the backend
 * (POST /tasks/:id/model) stores the new config id and the agent runtime
 * picks it up between LLM calls, preserving the conversation history.
 */
export function ModelSwitchDropdown({ task }: { task: Task }) {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  // Wraps trigger + menu so outside mousedown/Escape close the menu while
  // trigger clicks keep their toggle behavior (shared dismissal hook).
  const containerRef = React.useRef<HTMLDivElement>(null);
  useCloseOnOutside(containerRef, close);
  const configs = useLlmConfigs();
  const switchModel = useSwitchTaskModel();
  const enabled = (configs.data ?? []).filter((config) => config.enabled);

  function choose(config: LlmConfig) {
    close();
    if (config.id === task.effectiveLlmConfigId) return;
    switchModel.mutate(
      { id: task.id, llmConfigId: config.id },
      {
        onSuccess: () =>
          pushToast(`Switched to ${config.name} · ${config.model} — continuing task`),
      },
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label="Active model — switch mid-run"
        aria-expanded={open}
        title="Active model — switch while the task keeps running"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted"
        onClick={() => setOpen((value) => !value)}
        disabled={switchModel.isPending}
      >
        {switchModel.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        ) : (
          <ChevronUp className="h-3 w-3" aria-hidden />
        )}
        <span className="max-w-56 truncate font-medium">{currentLabel(task)}</span>
      </button>
      {open && (
        <ul className="absolute bottom-full left-0 z-50 mb-1 max-h-64 w-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {enabled.length === 0 && (
            <li className="px-2 py-1.5 text-muted-foreground">
              No enabled configs — add one in Settings
            </li>
          )}
          {enabled.map((config) => (
            <ModelMenuItem
              key={config.id}
              config={config}
              active={config.id === task.effectiveLlmConfigId}
              onChoose={choose}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
