/**
 * Right-side pane, bottom, left-aligned model dropdown for a pending
 * (not-started) proposal/prompt: shows the LLM config currently selected to
 * IMPLEMENT the task
 * and PATCHes it to another enabled config on selection. Unlike the console
 * footer's ModelSwitchDropdown (mid-run switch via POST /tasks/:id/model), this
 * only applies before START — the chosen config is stored on the task and
 * resolved when the task is queued.
 *
 * Reuses the composer's LlmConfigSelect (Radix) for visual consistency; the
 * `allowDefault={false}` variant omits the inherit option because the per-task
 * override is always a concrete config (§6: one parameterized select, not a copy).
 *
 * When the task has no per-task override (llmConfigId is null) — e.g. a proposal
 * created from a repo with no repo-level config — the task inherits the user's
 * default at START. The dropdown falls back to `effectiveLlmConfigId` for the
 * displayed value so the trigger always surfaces the concrete model that will
 * run, instead of rendering blank.
 */
import { useLlmConfigs, usePatchTaskLlmConfig, type Task } from '@/lib/hooks';
import { pushToast } from '@/lib/toasts';
import { LlmConfigSelect } from '@/components/console/TaskComposerControls';

export function PendingTaskModelSelect({ task }: { task: Task }) {
  const configs = useLlmConfigs();
  const patch = usePatchTaskLlmConfig();
  const enabled = (configs.data ?? []).filter((config) => config.enabled);
  const displayedId = task.llmConfigId ?? task.effectiveLlmConfigId ?? null;

  function choose(id: string | null) {
    // allowDefault={false} never yields null, but guard regardless: there is no
    // PATCH path to clear the override, so a null selection is a no-op.
    if (id === null || id === displayedId) return;
    patch.mutate(
      { id: task.id, llmConfigId: id },
      {
        onSuccess: () => {
          const chosen = enabled.find((config) => config.id === id);
          pushToast(`Model set to ${chosen?.name ?? id} — applies when you Start`);
        },
      },
    );
  }

  return (
    <LlmConfigSelect
      configs={enabled}
      value={displayedId}
      allowDefault={false}
      onChange={choose}
    />
  );
}
