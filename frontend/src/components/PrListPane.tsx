import { ExternalLink, GitMerge, Loader2, X } from 'lucide-react';

import { useMergeTask, useRepositories, useReviewTask, useTasks } from '@/lib/hooks';
import { inFlightPollInterval } from '@/lib/running-tasks';
import { selectPrTasks } from '@/lib/repo-tasks';
import { useWorkspaceSelection } from '@/lib/selection';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/StatusBadge';

/** Review/merge actions for a single PR row. */
function PrRowActions({
  taskId,
  status,
  reviewMutation,
  mergeMutation,
}: {
  taskId: string;
  status: string;
  reviewMutation: { isPending: boolean; mutate: (id: string) => void };
  mergeMutation: { isPending: boolean; mutate: (id: string) => void };
}) {
  const canAct = status === 'awaiting_review' || status === 'reviewing_code';
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={!canAct || reviewMutation.isPending}
        onClick={() => reviewMutation.mutate(taskId)}
      >
        {reviewMutation.isPending ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <GitMerge className="mr-1 h-3 w-3" />
        )}
        Review
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={!canAct || mergeMutation.isPending}
        onClick={() => mergeMutation.mutate(taskId)}
      >
        {mergeMutation.isPending ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <GitMerge className="mr-1 h-3 w-3" />
        )}
        Merge
      </Button>
    </div>
  );
}

/** One PR row in the center-pane list. */
function PrRow({
  task,
  reviewMutation,
  mergeMutation,
}: {
  task: Parameters<typeof selectPrTasks>[0][number];
  reviewMutation: { isPending: boolean; mutate: (id: string) => void };
  mergeMutation: { isPending: boolean; mutate: (id: string) => void };
}) {
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={task.title}>
          {task.title}
        </p>
        <div className="flex items-center gap-2">
          <span className="truncate text-xs text-muted-foreground">{task.branchName}</span>
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-0.5 text-xs text-blue-500 hover:underline"
            >
              PR <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
      <StatusBadge status={task.status} />
      <PrRowActions
        taskId={task.id}
        status={task.status}
        reviewMutation={reviewMutation}
        mergeMutation={mergeMutation}
      />
    </li>
  );
}

/**
 * Center-pane view of a repo's pull requests (open + recently merged/closed),
 * opened from the repo tree's git-merge button. Each PR row shows its status
 * and offers manual "Review with LLM" and "Merge with LLM" actions that
 * enqueue the backend review-pr / merge-gate jobs.
 */
export function PrListPane({ repositoryId }: { repositoryId: string }) {
  const { closePrReview } = useWorkspaceSelection();
  const repositoriesQuery = useRepositories();
  const repo = (repositoriesQuery.data ?? []).find((r) => r.id === repositoryId);
  const tasksQuery = useTasks(repositoryId, {
    refetchInterval: (query) => inFlightPollInterval(query.state.data as Parameters<typeof selectPrTasks>[0]),
  });
  const reviewMutation = useReviewTask();
  const mergeMutation = useMergeTask();
  const prTasks = selectPrTasks(tasksQuery.data ?? []);

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <GitMerge className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={repo?.fullName}>
          Pull requests — {repo?.fullName ?? repositoryId}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          aria-label="Close PR view"
          title="Close"
          onClick={closePrReview}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <PrTaskList
        isLoading={tasksQuery.isLoading}
        isError={tasksQuery.isError}
        prTasks={prTasks}
        reviewMutation={reviewMutation}
        mergeMutation={mergeMutation}
      />
    </section>
  );
}

function PrTaskList({
  isLoading,
  isError,
  prTasks,
  reviewMutation,
  mergeMutation,
}: {
  isLoading: boolean;
  isError: boolean;
  prTasks: Parameters<typeof selectPrTasks>[0];
  reviewMutation: { isPending: boolean; mutate: (id: string) => void };
  mergeMutation: { isPending: boolean; mutate: (id: string) => void };
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Loading pull requests…
      </div>
    );
  }
  if (isError) {
    return <p className="px-4 py-3 text-xs text-destructive">Failed to load pull requests.</p>;
  }
  if (prTasks.length === 0) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        No open or recently merged pull requests.
      </p>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto px-2 py-2">
      <ul className="flex flex-col gap-0.5">
        {prTasks.map((task) => (
          <PrRow
            key={task.id}
            task={task}
            reviewMutation={reviewMutation}
            mergeMutation={mergeMutation}
          />
        ))}
      </ul>
    </div>
  );
}
