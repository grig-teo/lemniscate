import * as React from 'react';

import { describeApiError } from '@/lib/api';
import {
  useCreateVpsTarget,
  useTestVpsTargetSaved,
  useTestVpsTargetUnsaved,
  useUpdateVpsTarget,
  type VpsAuthMethod,
  type VpsTarget,
  type VpsTestResult,
} from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/form-field';

interface FormState {
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: VpsAuthMethod;
  secret: string;
}

function initialState(initial?: VpsTarget): FormState {
  if (!initial) return { name: '', host: '', port: '22', username: 'root', authMethod: 'password', secret: '' };
  return {
    name: initial.name,
    host: initial.host,
    port: String(initial.port),
    username: initial.username,
    authMethod: initial.authMethod,
    secret: '',
  };
}

function toInput(form: FormState) {
  return {
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port) || 22,
    username: form.username.trim(),
    authMethod: form.authMethod,
    secret: form.secret,
  };
}

function TestResultView({ result }: { result: VpsTestResult }) {
  if (result.ok) {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs">
        <p className="font-medium">Connection OK — SSH reachable.</p>
        {result.echo && <p className="mt-1 text-muted-foreground">Echo: {result.echo}</p>}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
      Test failed: {result.error ?? 'unknown error'}
    </div>
  );
}

/**
 * Add/edit form for one VPS target. Includes a "Test connection" button that
 * probes the SSH endpoint before or after saving.
 */
export function VpsTargetForm({ initial, onDone }: { initial?: VpsTarget; onDone: () => void }) {
  const editing = initial !== undefined;
  const [form, setForm] = React.useState<FormState>(() => initialState(initial));
  const [error, setError] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<VpsTestResult | null>(null);

  const createTarget = useCreateVpsTarget();
  const updateTarget = useUpdateVpsTarget(initial?.id ?? '');
  const testUnsaved = useTestVpsTargetUnsaved();
  const testSaved = useTestVpsTargetSaved();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  };

  const saving = editing ? updateTarget.isPending : createTarget.isPending;
  const testing = testUnsaved.isPending || testSaved.isPending;

  const buildInput = () => {
    const input = toInput(form);
    if (!editing) return input;
    // On edit, secret is optional (omit to keep the stored credential).
    const { secret, ...fields } = input;
    return secret ? input : fields;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setTestResult(null);
    try {
      if (editing) {
        await updateTarget.mutateAsync(buildInput());
      } else {
        await createTarget.mutateAsync(buildInput() as Parameters<typeof createTarget.mutateAsync>[0]);
      }
      onDone();
    } catch (err) {
      setError(describeApiError(err as Error));
    }
  };

  const runTest = async () => {
    setError(null);
    setTestResult(null);
    try {
      // If editing an existing target and the secret field is blank, test the
      // saved credential by id; otherwise test the unsaved form payload.
      if (editing && !form.secret) {
        const result = await testSaved.mutateAsync(initial!.id);
        setTestResult(result);
      } else {
        const result = await testUnsaved.mutateAsync(toInput(form));
        setTestResult(result);
      }
    } catch (err) {
      setError(describeApiError(err as Error));
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Name">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="My VPS" required />
        </FormField>
        <FormField label="SSH host">
          <Input
            value={form.host}
            onChange={(e) => set('host', e.target.value)}
            placeholder="203.0.113.10 or vps.example.com"
            required
          />
        </FormField>
        <FormField label="Port">
          <Input
            value={form.port}
            inputMode="numeric"
            onChange={(e) => set('port', e.target.value)}
            placeholder="22"
            required
          />
        </FormField>
        <FormField label="Username">
          <Input value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="root" required />
        </FormField>
        <FormField label="Auth method">
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={form.authMethod}
            onChange={(e) => set('authMethod', e.target.value as VpsAuthMethod)}
          >
            <option value="password">Password</option>
            <option value="key">Private key</option>
          </select>
        </FormField>
      </div>
      <FormField label={editing ? `${form.authMethod === 'key' ? 'Private key' : 'Password'} (leave blank to keep current)` : form.authMethod === 'key' ? 'Private key (PEM)' : 'Password'}>
        {form.authMethod === 'key' ? (
          <Textarea
            value={form.secret}
            onChange={(e) => set('secret', e.target.value)}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            rows={4}
            className="font-mono text-xs"
            autoComplete="new-password"
            required={!editing}
          />
        ) : (
          <Input
            type="password"
            value={form.secret}
            onChange={(e) => set('secret', e.target.value)}
            placeholder={editing ? 'unchanged' : '••••••••'}
            autoComplete="new-password"
            required={!editing}
          />
        )}
      </FormField>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {testResult && <TestResultView result={testResult} />}

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="secondary" onClick={() => void runTest()} disabled={testing || saving}>
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onDone} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add target'}
          </Button>
        </div>
      </div>
    </form>
  );
}
