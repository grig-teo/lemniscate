import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField } from '@/components/ui/form-field';
import type { ThinkingLevel } from '@/lib/hooks';
import { NUMERIC_FIELDS, type FormState, type NumericField } from '@/lib/llm-config-form';

import type { SetField } from '@/components/settings/useLlmConfigForm';

const NUMERIC_INPUT_LABELS: Record<NumericField, { label: string; placeholder: string; min?: number; step?: number }> = {
  temperature: { label: 'Temperature', placeholder: '0.2', step: 0.1 },
  maxTokens: { label: 'Max tokens', placeholder: '4096', min: 1 },
  contextWindow: { label: 'Context window', placeholder: '128000', min: 1 },
  timeoutSeconds: { label: 'Timeout (seconds)', placeholder: '120', min: 1 },
  maxRetries: { label: 'Max retries', placeholder: '3', min: 0 },
  requestsPerMinute: { label: 'Requests per minute', placeholder: '60', min: 1 },
  maxTokensPerRun: { label: 'Max tokens per run', placeholder: '500000', min: 1 },
};

function NumericInput({
  field,
  form,
  set,
}: {
  field: NumericField;
  form: FormState;
  set: SetField;
}) {
  const { label, placeholder, min, step } = NUMERIC_INPUT_LABELS[field];
  return (
    <FormField label={label}>
      <Input
        type="number"
        min={min}
        step={step}
        value={form[field]}
        onChange={(e) => set(field, e.target.value)}
        placeholder={placeholder}
      />
    </FormField>
  );
}

function ThinkingLevelField({ form, set }: { form: FormState; set: SetField }) {
  return (
    <FormField label="Thinking level">
      <Select
        value={form.thinkingLevel}
        onValueChange={(value) => set('thinkingLevel', value as ThinkingLevel)}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">off</SelectItem>
          <SelectItem value="low">low</SelectItem>
          <SelectItem value="medium">medium</SelectItem>
          <SelectItem value="high">high</SelectItem>
        </SelectContent>
      </Select>
    </FormField>
  );
}

function ApiKeyField({ form, set, editing }: { form: FormState; set: SetField; editing: boolean }) {
  return (
    <FormField label={editing ? 'API key (leave blank to keep current)' : 'API key'}>
      <Input
        type="password"
        value={form.apiKey}
        onChange={(e) => set('apiKey', e.target.value)}
        placeholder={editing ? 'unchanged' : 'sk-…'}
        autoComplete="new-password"
      />
    </FormField>
  );
}

/** The two-column grid of core + numeric fields of the LLM config form. */
export function LlmConfigFields({
  form,
  set,
  editing,
}: {
  form: FormState;
  set: SetField;
  editing: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <FormField label="Name">
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="My Hermes 70B" required />
      </FormField>
      <FormField label="Model">
        <Input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="gpt-4o-mini" required />
      </FormField>
      <FormField label="Base URL">
        <Input
          value={form.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
          placeholder="https://api.openai.com/v1"
          required
        />
      </FormField>
      <ApiKeyField form={form} set={set} editing={editing} />
      <ThinkingLevelField form={form} set={set} />
      {NUMERIC_FIELDS.map((field) => (
        <NumericInput key={field} field={field} form={form} set={set} />
      ))}
    </div>
  );
}
