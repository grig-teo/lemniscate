import { useState } from 'react';
import { Loader2, X } from 'lucide-react';

import { useRepositories, useTasks } from '@/lib/hooks';
import { sortByArchivedAtDesc } from '@/lib/repo-tasks';
import { useWorkspaceSelection } from '@/lib/selection';
import { ArchivedTaskRow } from '@/components/repo-tree/ArchivedTaskRow';
import { Button } from '@/components/ui/button';

/** Rows per page in the center-pane archived list. */
const ARCHIVED_PAGE_SIZE = 20;

/**
 * Center-pane view of one repo's full archived task list, opened from the
 * repo tree's "show more" and closed with the X (or by selecting a task).
 */
export function ArchivedPane({ repositoryId }: { repositoryId: string }) {
  const { closeArchived } = useWorkspaceSelection();
  const repositoriesQuery = useRepositories();
  const repo = (repositoriesQuery.data ?? []).find((r) => r.id === repositoryId);
  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={repo?.fullName}>
          {repo?.fullName ?? 'Archived tasks'}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          aria-label="Close archived view"
          title="Close archived view"
          onClick={closeArchived}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <ArchivedTaskList repositoryId={repositoryId} />
    </section>
  );
}

function ArchivedTaskList({ repositoryId }: { repositoryId: string }) {
  const archivedQuery = useTasks(repositoryId, { archived: true });
  if (archivedQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Loading archived tasks…
      </div>
    );
  }
  if (archivedQuery.isError) {
    return <p className="px-4 py-3 text-xs text-destructive">Failed to load archived tasks.</p>;
  }
  return <PagedArchivedTasks tasks={sortByArchivedAtDesc(archivedQuery.data ?? [])} />;
}

function PagedArchivedTasks({ tasks }: { tasks: ReturnType<typeof sortByArchivedAtDesc> }) {
  const [pageCount, setPageCount] = useState(1);
  const visible = tasks.slice(0, pageCount * ARCHIVED_PAGE_SIZE);
  if (tasks.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">No archived tasks.</p>;
  }
  return (
    <div className="flex-1 overflow-y-auto px-2 py-2">
      <ul className="flex flex-col gap-0.5">
        {visible.map((task) => (
          <ArchivedTaskRow key={task.id} task={task} />
        ))}
      </ul>
      {visible.length < tasks.length && (
        <div className="flex justify-center py-2">
          <Button variant="ghost" size="sm" onClick={() => setPageCount((n) => n + 1)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
