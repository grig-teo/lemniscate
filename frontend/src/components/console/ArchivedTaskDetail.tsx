import { ExternalLink, GitBranch, Loader2, X } from 'lucide-react';

import { useTask, type Task } from '@/lib/hooks';
import { useWorkspaceSelection, type SelectedTask } from '@/lib/selection';
import { prUrlHref } from '@/lib/url';
import { StatusBadge } from '@/components/StatusBadge';
import { TokensBadge } from '@/components/TokensBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConsoleLog } from '@/components/console/ConsoleLog';
import { ErrorBanner } from '@/components/console/ErrorBanner';
import { useTaskEventHistory } from '@/components/console/useTaskConsole';

/**
 * Read-only view of an archived task, opened by clicking an archived row:
 * the task details (prompt, branch, PR, model, timestamps) on top and the
 * archived console log history (REST only — archived tasks never stream)
 * below. No mutating actions; closing returns to the previous view.
 */
export function ArchivedTaskDetail({ task }: { task: SelectedTask }) {
  const history = useTaskEventHistory(task.id);
  const taskQuery = useTask(task.id);
  const status = history.historyStatus ?? task.status;
  const errorCode = status === 'failed' ? taskQuery.data?.errorCode : undefined;
  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col" aria-label="Archived task details">
      <ArchivedDetailHeader task={task} status={status} detail={taskQuery.data} />
      <ErrorBanner errorCode={errorCode} />
      <ArchivedDetailBody detail={taskQuery.data} isLoading={taskQuery.isLoading} />
      <div className="shrink-0 border-b px-4 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Console history
      </div>
      <ConsoleLog
        historyQuery={history.historyQuery}
        historyLogs={history.historyLogs}
        liveLogs={[]}
        streamError={false}
      />
    </section>
  );
}

function ArchivedDetailHeader({
  task,
  status,
  detail,
}: {
  task: SelectedTask;
  status: string;
  detail: Task | undefined;
}) {
  const { closeArchivedTask } = useWorkspaceSelection();
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={task.title}>
        {task.title}
      </span>
      <Badge variant="outline" className="shrink-0">
        Archived
      </Badge>
      <StatusBadge status={status} />
      {detail && (
        <TokensBadge
          used={detail.llmTokensUsed}
          max={detail.maxTokensPerRun ?? null}
          running={false}
          costUsd={detail.estimatedCostUsd ?? null}
        />
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        aria-label="Close archived task details"
        title="Close archived task details"
        onClick={closeArchivedTask}
      >
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

function ArchivedDetailBody({
  detail,
  isLoading,
}: {
  detail: Task | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Loading task details…
      </div>
    );
  }
  if (!detail) return null;
  return (
    <div className="shrink-0 border-b px-4 py-3">
      {detail.prompt && (
        <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 font-mono text-xs">
          {detail.prompt}
        </pre>
      )}
      <DetailMeta detail={detail} />
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function DetailMeta({ detail }: { detail: Task }) {
  // gitlem PR URLs are root-relative; resolve them against the app base.
  const prHref = detail.prUrl ? prUrlHref(detail.prUrl) : null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {detail.branchName && (
        <span className="flex items-center gap-1">
          <GitBranch className="h-3.5 w-3.5" aria-hidden />
          <span className="max-w-40 truncate font-mono">{detail.branchName}</span>
        </span>
      )}
      {prHref && (
        <a
          href={prHref}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-blue-500 hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          Pull request
        </a>
      )}
      {detail.llmModel && <span>Model: {detail.llmModel}</span>}
      <span>Created {formatTimestamp(detail.createdAt)}</span>
      {detail.archivedAt && <span>Archived {formatTimestamp(detail.archivedAt)}</span>}
    </div>
  );
}
