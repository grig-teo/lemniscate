import type { LlmTestResult } from '@/lib/hooks';

function TestOkBanner({ result }: { result: LlmTestResult }) {
  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs">
      <p className="font-medium">
        Connection OK{result.latencyMs !== undefined ? ` in ${result.latencyMs} ms` : ''}
      </p>
      <p className="mt-1 text-muted-foreground">
        Model: {result.modelEcho ?? '—'} · Reply: {result.reply ?? '—'}
      </p>
    </div>
  );
}

/** Outcome banner of the "Test connection" button. */
export function TestResultBanner({ result }: { result: LlmTestResult }) {
  if (!result.ok) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
        Test failed: {result.error ?? 'unknown error'}
      </div>
    );
  }
  return <TestOkBanner result={result} />;
}
