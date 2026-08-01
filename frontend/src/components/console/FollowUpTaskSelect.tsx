import { useSetTaskFollows, useTasks, type Task } from '@/lib/hooks';
import { followUpCandidates, followUpStatusLabel } from '@/lib/follow-up';
import { pushToast } from '@/lib/toasts';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Renders the follow-up dropdown as a controlled select (no own mutation). */
export function FollowUpSelect({
  candidates,
  value,
  onChange,
  triggerClassName,
}: {
  candidates: Task[];
  value: string | null;
  onChange: (nextTaskId: string | null) => void;
  triggerClassName?: string;
}) {
  return (
    <Select value={value ?? 'none'} onValueChange={(v) => onChange(v === 'none' ? null : v)}>
      <SelectTrigger className={triggerClassName ?? 'h-8 w-48 shrink-0'} aria-label="Follow-up task">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No follow-up</SelectItem>
        {candidates.map((task) => (
          <SelectItem key={task.id} value={task.id}>
            <span className="flex w-full items-center gap-2">
              <span className="truncate">{task.title}</span>
              <span className="ml-auto shrink-0 pl-2 text-xs capitalize text-muted-foreground">
                {followUpStatusLabel(task.status)}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Self-contained follow-up dropdown for a proposal/prompt in the right pane:
 * shows the task's current follow-up and POSTs /tasks/:id/follows on choose
 * (mirrors PendingTaskModelSelect's PATCH-on-choose). Lists all non-archived
 * tasks of the same repository — proposals, prompts running, in review, code
 * review, done, … — excluding the task itself.
 */
export function FollowUpTaskSelect({ task }: { task: Task }) {
  const tasks = useTasks(task.repositoryId);
  const setFollows = useSetTaskFollows();
  const candidates = followUpCandidates(tasks.data ?? [], task.id);

  function choose(nextTaskId: string | null) {
    if (nextTaskId === task.nextTaskId) return;
    setFollows.mutate(
      { id: task.id, nextTaskId },
      {
        onSuccess: () => {
          const chosen = candidates.find((t) => t.id === nextTaskId);
          pushToast(chosen ? `Follow-up set to "${chosen.title}"` : 'Follow-up cleared');
        },
      },
    );
  }

  return <FollowUpSelect candidates={candidates} value={task.nextTaskId ?? null} onChange={choose} />;
}
