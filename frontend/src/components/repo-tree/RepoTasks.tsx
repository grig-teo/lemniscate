import type { ReactNode } from 'react';
import { Loader2, Play, RotateCcw } from 'lucide-react';

import { useRerunTask, useStartTask, useTasks, type Task } from '@/lib/hooks';
import { groupRepoTasks, isStartableTask } from '@/lib/repo-tasks';
import { useWorkspaceSelection } from '@/lib/selection';
import { cn } from '@/lib/utils';
import { GenerateProposalsButton } from '@/components/repo-tree/GenerateProposalsButton';
import { StatusBadge } from '@/components/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/** Tasks of one expanded repo, split into proposals, saved prompts, and running processes. */
export function RepoTasks({ repositoryId }: { repositoryId: string }) {
  const tasksQuery = useTasks(repositoryId);
  if (tasksQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 pl-9 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Loading tasks…
      </div>
    );
  }
  if (tasksQuery.isError) {
    return <p className="py-1 pl-9 text-xs text-destructive">Failed to load tasks.</p>;
  }
  return <TaskGroups repositoryId={repositoryId} tasks={tasksQuery.data ?? []} />;
}

function TaskGroups({ repositoryId, tasks }: { repositoryId: string; tasks: Task[] }) {
  const { proposals, prompts, processes } = groupRepoTasks(tasks);
  return (
    <div className="flex flex-col gap-1 py-1 pl-5">
      <TaskGroup label="Proposals" action={<GenerateProposalsButton repositoryId={repositoryId} />}>
        {proposals.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
        {proposals.length === 0 && prompts.length === 0 && processes.length === 0 && (
          <li className="px-2 py-0.5 text-[11px] text-muted-foreground/70">No tasks yet.</li>
        )}
      </TaskGroup>
      {prompts.length > 0 && (
        <TaskGroup label="Prompts">
          {prompts.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </TaskGroup>
      )}
      {processes.length > 0 && (
        <TaskGroup label="Running processes">
          {processes.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </TaskGroup>
      )}
    </div>
  );
}

/** Labeled section with a small muted heading and an optional header action. */
function TaskGroup({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 py-0.5 pl-2 pr-1">
        <span className="flex-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {label}
        </span>
        {action}
      </div>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

function TaskRow({ task }: { task: Task }) {
  const { selectedTask, selectTask } = useWorkspaceSelection();
  return (
    <li>
      <button
        type="button"
        onClick={() => selectTask(toSelectedTask(task))}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent',
          selectedTask?.id === task.id && 'bg-accent font-medium',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        {task.kind === 'proposal' && (
          <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
            proposal
          </Badge>
        )}
        <StatusBadge status={task.status} className="px-1.5 py-0 text-[10px]" />
        {isStartableTask(task) && <StartTaskButton task={task} />}
        {task.status === 'failed' && <RerunTaskButton task={task} />}
      </button>
    </li>
  );
}

function toSelectedTask(task: Task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    kind: task.kind,
    repositoryId: task.repositoryId,
    branchName: task.branchName ?? null,
    prUrl: task.prUrl ?? null,
  };
}

/** Play button that queues a pending proposal or saved-for-later prompt. */
function StartTaskButton({ task }: { task: Task }) {
  const startTask = useStartTask();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-5 w-5 shrink-0"
      aria-label={`Start ${task.title}`}
      disabled={startTask.isPending}
      onClick={(event) => {
        event.stopPropagation();
        startTask.mutate(task.id);
      }}
    >
      {startTask.isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Play className="h-3 w-3" />
      )}
    </Button>
  );
}

/** Rerun button that re-queues a failed task with fresh run state. */
function RerunTaskButton({ task }: { task: Task }) {
  const rerunTask = useRerunTask();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-5 w-5 shrink-0"
      aria-label={`Rerun ${task.title}`}
      disabled={rerunTask.isPending}
      onClick={(event) => {
        event.stopPropagation();
        rerunTask.mutate(task.id);
      }}
    >
      {rerunTask.isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <RotateCcw className="h-3 w-3" />
      )}
    </Button>
  );
}
