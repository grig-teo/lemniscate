import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

import { useTasks, useUpdateRepositoryFlags, type Repository, type Task } from '@/lib/hooks';
import { useWorkspaceSelection } from '@/lib/selection';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/StatusBadge';
import { Switch } from '@/components/ui/switch';

const SWITCH_CLASS =
  'h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3';

function FlagSwitch({
  label,
  ariaLabel,
  checked,
  disabled,
  disabledTitle,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  disabledTitle?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-1.5 text-[11px] text-muted-foreground',
        disabled && 'opacity-50',
      )}
      title={disabled ? disabledTitle : undefined}
    >
      <Switch
        className={SWITCH_CLASS}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={ariaLabel}
      />
      {label}
    </label>
  );
}

function RepoFlags({ repo }: { repo: Repository }) {
  const updateFlags = useUpdateRepositoryFlags();
  const patch = (flags: Parameters<typeof updateFlags.mutate>[0]['patch']) =>
    updateFlags.mutate({ id: repo.id, patch: flags });

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-7 pr-1 pt-0.5">
      <FlagSwitch
        label="propose"
        ariaLabel={`Auto-propose for ${repo.fullName}`}
        checked={repo.autoPropose}
        onChange={(checked) => patch({ autoPropose: checked })}
      />
      <FlagSwitch
        label="PR"
        ariaLabel={`Auto-create PR for ${repo.fullName}`}
        checked={repo.autoCreatePr}
        onChange={(checked) => patch({ autoCreatePr: checked })}
      />
      <FlagSwitch
        label="review"
        ariaLabel={`Auto-review PRs for ${repo.fullName}`}
        checked={repo.autoReviewPr}
        // Disabling review also disables merge — merging requires a review.
        onChange={(checked) =>
          patch(checked ? { autoReviewPr: true } : { autoReviewPr: false, autoMergePr: false })
        }
      />
      <FlagSwitch
        label="merge"
        ariaLabel={`Auto-merge PRs for ${repo.fullName}`}
        checked={repo.autoMergePr}
        disabled={!repo.autoReviewPr}
        disabledTitle="Enable auto-review first"
        onChange={(checked) => patch({ autoMergePr: checked })}
      />
    </div>
  );
}

export function RepoRow({
  repo,
  expanded,
  onToggle,
}: {
  repo: Repository;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="px-2 pb-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent"
        aria-expanded={expanded}
      >
        <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{repo.name}</span>
      </button>

      <RepoFlags repo={repo} />

      {expanded && <RepoTasks repositoryId={repo.id} />}
    </div>
  );
}

function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: Task;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent',
          selected && 'bg-accent font-medium',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        <StatusBadge status={task.status} className="px-1.5 py-0 text-[10px]" />
      </button>
    </li>
  );
}

function RepoTasks({ repositoryId }: { repositoryId: string }) {
  const tasksQuery = useTasks(repositoryId);
  const { selectedTask, selectTask } = useWorkspaceSelection();

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
  const tasks = tasksQuery.data ?? [];
  if (tasks.length === 0) {
    return <p className="py-1 pl-9 text-xs text-muted-foreground/70">No tasks yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-0.5 py-1 pl-5">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          selected={selectedTask?.id === task.id}
          onSelect={() =>
            selectTask({
              id: task.id,
              title: task.title,
              status: task.status,
              kind: task.kind,
              branchName: task.branchName ?? null,
              prUrl: task.prUrl ?? null,
            })
          }
        />
      ))}
    </ul>
  );
}
