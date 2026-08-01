import { useSetTaskFollows, useTasks, type Task } from '@/lib/hooks';
import { pushToast } from '@/lib/toasts';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Eligible follow-up successors: idle tasks in the same repo (the only
// statuses triggerNextTask will actually auto-start). The predecessor itself
// is excluded (a task cannot follow itself, enforced server-side too).
const FOLLOWABLE_STATUSES = ['pending', 'queued'];

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
            <span className="truncate">{task.title}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Self-contained follow-up dropdown for a pending proposal/prompt in the right
 * pane: shows the task's current follow-up and POSTs /tasks/:id/follows on
 * choose (mirrors PendingTaskModelSelect's PATCH-on-choose). Lists only idle
 * successors in the same repository, excluding the task itself.
 */
export function FollowUpTaskSelect({ task }: { task: Task }) {
  const tasks = useTasks(task.repositoryId);
  const setFollows = useSetTaskFollows();
  const candidates = (tasks.data ?? [])
    .filter((t) => t.id !== task.id && (FOLLOWABLE_STATUSES as readonly string[]).includes(t.status));

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
