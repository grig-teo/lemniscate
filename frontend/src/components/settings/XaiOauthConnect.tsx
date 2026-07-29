import * as React from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField } from '@/components/ui/form-field';
import { describeApiError } from '@/lib/api';
import {
  useCompleteXaiOauth,
  usePollXaiOauth,
  useStartXaiOauth,
  type XaiOauthStart,
} from '@/lib/queries/xai-oauth';

type Phase =
  | { kind: 'idle' }
  | { kind: 'waiting'; session: XaiOauthStart; intervalMs: number }
  | { kind: 'pick-model'; session: XaiOauthStart }
  | { kind: 'error'; message: string };

/**
 * Settings → LLM configs: Connect with xAI (SuperGrok / X Premium+) via
 * OAuth device code. After browser approval the user picks a coding model
 * (default grok-4.5) and an LlmConfig row is created.
 */
export function XaiOauthConnect({ onDone }: { onDone: () => void }) {
  const start = useStartXaiOauth();
  const poll = usePollXaiOauth();
  const complete = useCompleteXaiOauth();
  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' });
  const [model, setModel] = React.useState('grok-4.5');
  const [isDefault, setIsDefault] = React.useState(true);

  React.useEffect(() => {
    if (phase.kind !== 'waiting') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sessionId = phase.session.sessionId;
    const baseInterval = phase.intervalMs;
    const defaultModel = phase.session.defaultModel || 'grok-4.5';
    const session = phase.session;

    const tick = async () => {
      try {
        const result = await poll.mutateAsync(sessionId);
        if (cancelled) return;
        if (result.status === 'authorized') {
          setModel(defaultModel);
          setPhase({ kind: 'pick-model', session });
          return;
        }
        const nextMs =
          result.status === 'slow_down'
            ? Math.min((result.interval ?? session.interval) * 1000, 30_000)
            : baseInterval;
        timer = setTimeout(() => void tick(), nextMs);
      } catch (err) {
        if (cancelled) return;
        setPhase({
          kind: 'error',
          message: err instanceof Error ? describeApiError(err) : 'OAuth poll failed',
        });
      }
    };
    timer = setTimeout(() => void tick(), baseInterval);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Intentionally depend on phase identity only; poll mutation is stable enough
    // for one wait cycle and restarts when phase changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind === 'waiting' ? phase.session.sessionId : null]);

  async function begin() {
    try {
      const session = await start.mutateAsync();
      setPhase({
        kind: 'waiting',
        session,
        intervalMs: Math.max(1000, session.interval * 1000),
      });
      window.open(session.verificationUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? describeApiError(err) : 'Could not start xAI login',
      });
    }
  }

  async function finish() {
    if (phase.kind !== 'pick-model') return;
    try {
      await complete.mutateAsync({
        sessionId: phase.session.sessionId,
        model,
        isDefault,
        name: 'Grok (xAI OAuth)',
      });
      onDone();
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? describeApiError(err) : 'Could not save xAI connection',
      });
    }
  }

  if (phase.kind === 'waiting') {
    return (
      <WaitingPanel
        session={phase.session}
        onCancel={() => setPhase({ kind: 'idle' })}
      />
    );
  }

  if (phase.kind === 'pick-model') {
    return (
      <ModelPickPanel
        models={phase.session.models}
        model={model}
        isDefault={isDefault}
        saving={complete.isPending}
        onModel={setModel}
        onDefault={setIsDefault}
        onSave={() => void finish()}
        onCancel={() => setPhase({ kind: 'idle' })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Connect with xAI</p>
          <p className="text-xs text-muted-foreground">
            SuperGrok or X Premium+ — browser login, no API key. Default model: grok-4.5.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => void begin()} disabled={start.isPending}>
          {start.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Starting…
            </>
          ) : (
            'Connect with xAI'
          )}
        </Button>
      </div>
      {phase.kind === 'error' && <p className="text-sm text-destructive">{phase.message}</p>}
    </div>
  );
}

function WaitingPanel({
  session,
  onCancel,
}: {
  session: XaiOauthStart;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <p className="text-sm font-medium">Approve access in your browser</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>
          Open{' '}
          <a
            href={session.verificationUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-foreground underline"
          >
            {session.verificationUrl}
            <ExternalLink className="h-3 w-3" />
          </a>
        </li>
        <li>
          If prompted, enter code{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
            {session.userCode}
          </code>
        </li>
      </ol>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Waiting for approval…
      </p>
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ModelPickPanel({
  models,
  model,
  isDefault,
  saving,
  onModel,
  onDefault,
  onSave,
  onCancel,
}: {
  models: string[];
  model: string;
  isDefault: boolean;
  saving: boolean;
  onModel: (value: string) => void;
  onDefault: (value: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const options = models.length > 0 ? models : [model];
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <p className="text-sm font-medium">xAI connected — choose coding model</p>
      <FormField label="Model">
        <Select value={model} onValueChange={onModel}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => onDefault(e.target.checked)}
        />
        Set as default LLM config
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save connection'}
        </Button>
      </div>
    </div>
  );
}
