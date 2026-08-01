import { Loader2, Play } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useGitlemCiRuns, useTriggerGitlemCi, type GitlemCiRun } from '@/lib/hooks';

const STATUS_BADGE: Record<GitlemCiRun['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' }> = {
  queued: { label: 'queued', variant: 'secondary' },
  running: { label: 'running', variant: 'secondary' },
  success: { label: 'success', variant: 'default' },
  failed: { label: 'failed', variant: 'destructive' },
};

/** Recent CI runs for the repo + a "Run CI" trigger for the active branch. */
export function GitlemCiPanel({ name, branch }: { name: string; branch: string }) {
  const runs = useGitlemCiRuns(name);
  const trigger = useTriggerGitlemCi(name);
  const list = runs.data ?? [];

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          CI / CD
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => trigger.mutate(branch)}
          disabled={trigger.isPending}
        >
          {trigger.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run CI on {branch}
        </Button>
      </div>
      {trigger.isError && (
        <p className="text-xs text-destructive">{trigger.error.message}</p>
      )}
      {runs.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading runs…
        </div>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">No CI runs yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {list.slice(0, 5).map((run) => (
            <li key={run.id} className="flex items-center gap-2 text-xs">
              <Badge variant={STATUS_BADGE[run.status].variant}>{STATUS_BADGE[run.status].label}</Badge>
              <span className="text-muted-foreground">{run.branch}</span>
              <span className="truncate font-mono text-muted-foreground/70">
                {run.log.split('\n').pop()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
