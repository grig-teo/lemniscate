import * as React from 'react';

import {
  useCreateLlmConfig,
  useTestLlmConfig,
  useUpdateLlmConfig,
  type LlmConfig,
  type LlmConfigPayload,
  type LlmTestResult,
} from '@/lib/hooks';
import { buildPayload, DEFAULTS, fromConfig, type FormState } from '@/lib/llm-config-form';

export type SetField = <K extends keyof FormState>(field: K, value: FormState[K]) => void;

type PayloadBuilder = () => LlmConfigPayload | null;

/** Validation gate shared by Save and Test: builds the payload or shows the error. */
function usePayloadBuilder(form: FormState) {
  const [formError, setFormError] = React.useState<string | null>(null);
  const buildValidPayload: PayloadBuilder = () => {
    setFormError(null);
    const built = buildPayload(form);
    if ('error' in built) {
      setFormError(built.error);
      return null;
    }
    return built.payload;
  };
  return { formError, buildValidPayload };
}

/** Create-or-update save action plus its pending/error state. */
function useSaveConfig(
  initial: LlmConfig | undefined,
  onDone: () => void,
  buildValidPayload: PayloadBuilder,
) {
  const createConfig = useCreateLlmConfig();
  const updateConfig = useUpdateLlmConfig();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const payload = buildValidPayload();
    if (!payload) return;
    const onSuccess = () => onDone();
    if (initial) {
      updateConfig.mutate({ id: initial.id, payload }, { onSuccess });
      return;
    }
    createConfig.mutate(payload, { onSuccess });
  };

  return {
    submit,
    saving: createConfig.isPending || updateConfig.isPending,
    saveError: createConfig.error ?? updateConfig.error,
  };
}

/**
 * "Test connection" action: tests the saved config by id (stored API key)
 * when editing with an untouched key field, otherwise posts the form payload.
 */
function useTestConnection(
  initial: LlmConfig | undefined,
  form: FormState,
  buildValidPayload: PayloadBuilder,
) {
  const [testResult, setTestResult] = React.useState<LlmTestResult | null>(null);
  const testConfig = useTestLlmConfig();

  const runTest = () => {
    setTestResult(null);
    const payload = buildValidPayload();
    if (!payload) return;
    const callbacks = {
      onSuccess: (result: LlmTestResult) => setTestResult(result),
      onError: (error: Error) => setTestResult({ ok: false, error: error.message }),
    };
    if (initial && !form.apiKey) {
      testConfig.mutate({ id: initial.id }, callbacks);
      return;
    }
    testConfig.mutate({ payload }, callbacks);
  };

  return { testResult, testing: testConfig.isPending, runTest };
}

/**
 * State and actions for the LLM config add/edit form: field values,
 * validation errors, save (create or update), and "Test connection".
 */
export function useLlmConfigForm(initial: LlmConfig | undefined, onDone: () => void) {
  const [form, setForm] = React.useState<FormState>(() => (initial ? fromConfig(initial) : DEFAULTS));
  const set: SetField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const { formError, buildValidPayload } = usePayloadBuilder(form);
  const save = useSaveConfig(initial, onDone, buildValidPayload);
  const test = useTestConnection(initial, form, buildValidPayload);

  return { form, set, formError, ...save, ...test };
}
