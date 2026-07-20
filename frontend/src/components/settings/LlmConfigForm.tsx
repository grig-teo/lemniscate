import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/form-field';
import type { LlmConfig } from '@/lib/hooks';
import type { FormState } from '@/lib/llm-config-form';

import { LlmConfigFields } from '@/components/settings/LlmConfigFields';
import { TestResultBanner } from '@/components/settings/TestResultBanner';
import { useLlmConfigForm, type SetField } from '@/components/settings/useLlmConfigForm';

function OptionalTextareas({ form, set }: { form: FormState; set: SetField }) {
  return (
    <>
      <FormField label="System prompt extra (optional)">
        <Textarea
          value={form.systemPromptExtra}
          onChange={(e) => set('systemPromptExtra', e.target.value)}
          placeholder="Extra instructions appended to the agent system prompt…"
          rows={3}
        />
      </FormField>
      <FormField label='Custom headers as JSON (optional), e.g. {"X-Org": "team"}'>
        <Textarea
          value={form.customHeaders}
          onChange={(e) => set('customHeaders', e.target.value)}
          placeholder="{}"
          rows={3}
          className="font-mono text-xs"
        />
      </FormField>
    </>
  );
}

function FlagSwitches({ form, set }: { form: FormState; set: SetField }) {
  return (
    <div className="flex gap-6">
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={form.isDefault} onCheckedChange={(checked) => set('isDefault', checked)} />
        Default config
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={form.enabled} onCheckedChange={(checked) => set('enabled', checked)} />
        Enabled
      </label>
    </div>
  );
}

function saveLabel(saving: boolean, editing: boolean): string {
  if (saving) return 'Saving…';
  return editing ? 'Save changes' : 'Add config';
}

function FormActions({
  testing,
  saving,
  editing,
  onTest,
  onCancel,
}: {
  testing: boolean;
  saving: boolean;
  editing: boolean;
  onTest: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Button type="button" variant="secondary" onClick={onTest} disabled={testing || saving}>
        {testing ? 'Testing…' : 'Test connection'}
      </Button>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saveLabel(saving, editing)}
        </Button>
      </div>
    </div>
  );
}

/**
 * Add/edit form for one LLM config. Includes the "Test connection" button:
 * it tests a saved config by id (stored API key) when the key field is left
 * untouched, otherwise it posts the unsaved form payload.
 */
export function LlmConfigForm({ initial, onDone }: { initial?: LlmConfig; onDone: () => void }) {
  const state = useLlmConfigForm(initial, onDone);
  const editing = initial !== undefined;

  return (
    <form onSubmit={state.submit} className="flex flex-col gap-4">
      <LlmConfigFields form={state.form} set={state.set} editing={editing} />
      <OptionalTextareas form={state.form} set={state.set} />
      <FlagSwitches form={state.form} set={state.set} />

      {state.formError && <p className="text-sm text-destructive">{state.formError}</p>}
      {state.saveError && <p className="text-sm text-destructive">{state.saveError.message}</p>}
      {state.testResult && <TestResultBanner result={state.testResult} />}

      <FormActions
        testing={state.testing}
        saving={state.saving}
        editing={editing}
        onTest={state.runTest}
        onCancel={onDone}
      />
    </form>
  );
}
