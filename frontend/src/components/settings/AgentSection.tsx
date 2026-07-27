import { Loader2 } from 'lucide-react';

import { describeApiError } from '@/lib/api';
import type { AgentExecutor, AgentSettings } from '@/lib/api-types';
import { useAgentSettings, useUpdateAgentExecutor } from '@/lib/queries/settings';
import { cn } from '@/lib/utils';

/**
 * Settings → Agent: which core agent executes tasks. 'hermes' is the
 * current default (Hermes Agent CLI inside the cloned repo); 'internal' is
 * the in-house agent under development (built-in LLM propose/apply loop).
 * Backed by GET/PUT /api/settings.
 */
export function AgentSection() {
  const settings = useAgentSettings();
  const update = useUpdateAgentExecutor();

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">Core agent</h3>
        <p className="text-xs text-muted-foreground">
          Choose which agent executes your tasks. Applies to new runs.
        </p>
      </div>
      {settings.isLoading && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading settings…
        </p>
      )}
      {settings.isError && <p className="text-xs text-destructive">Failed to load settings.</p>}
      {settings.data && (
        <AgentExecutorChoice
          settings={settings.data}
          disabled={update.isPending}
          onSelect={(value) => update.mutate(value)}
        />
      )}
      {update.isError && (
        <p className="text-xs text-destructive">
          Could not save the agent choice: {describeApiError(update.error)}
        </p>
      )}
    </section>
  );
}

const EXECUTOR_OPTIONS: { value: AgentExecutor; label: string; description: string }[] = [
  {
    value: 'hermes',
    label: 'Hermes agent',
    description: 'The current default. Runs the Hermes Agent CLI inside the cloned repository.',
  },
  {
    value: 'internal',
    label: 'Internal agent',
    description: 'The in-house agent (in development). Uses the built-in LLM propose/apply loop.',
  },
];

function AgentExecutorChoice({
  settings,
  disabled,
  onSelect,
}: {
  settings: AgentSettings;
  disabled: boolean;
  onSelect: (value: AgentExecutor) => void;
}) {
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="Core agent">
      {EXECUTOR_OPTIONS.map((option) => (
        <AgentOption
          key={option.value}
          option={option}
          checked={settings.agentExecutor === option.value}
          isDefault={settings.defaultAgentExecutor === option.value}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function AgentOption({
  option,
  checked,
  isDefault,
  disabled,
  onSelect,
}: {
  option: { value: AgentExecutor; label: string; description: string };
  checked: boolean;
  isDefault: boolean;
  disabled: boolean;
  onSelect: (value: AgentExecutor) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onSelect(option.value)}
      className={cn(
        'flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left transition-colors hover:border-foreground/40 disabled:opacity-60',
        checked && 'border-primary bg-primary/10',
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {option.label}
        {isDefault && (
          <span className="rounded-full border px-1.5 text-[10px] text-muted-foreground">
            deployment default
          </span>
        )}
      </span>
      <span className="text-xs text-muted-foreground">{option.description}</span>
    </button>
  );
}
