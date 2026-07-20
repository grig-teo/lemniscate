import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { StatusBadge } from '@/components/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { groupByConnection, type ConnectionGroup } from '@/lib/group-repos';
import { useRepositories, useTasks, type Repository, type Task } from '@/lib/hooks';
import { ProviderIcon, providerLabel } from '@/lib/providers';
import { groupTasksByRepository, selectRunningTasks } from '@/lib/running-tasks';

function ConnectionCard({ group }: { group: ConnectionGroup }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <ProviderIcon provider={group.provider} className="h-4 w-4" />
        <span className="font-medium">{providerLabel(group.provider)}</span>
        <span className="text-muted-foreground">@{group.username}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {group.repos.map((repo) => (
          <li key={repo.id}>
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
              {repo.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConnectedHosts({ repositories }: { repositories: Repository[] }) {
  const groups = groupByConnection(repositories);
  return (
    <section aria-label="Connected git hosts" className="mt-14">
      <h2 className="mb-4 font-mono text-sm font-semibold">Connected git hosts</h2>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No connected git hosts yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <ConnectionCard key={group.connectionId} group={group} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunningTaskRow({ task }: { task: Task }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <Badge variant="outline" className="shrink-0">
        {task.kind}
      </Badge>
      <StatusBadge status={task.status} />
    </li>
  );
}

function RunningProcesses({ tasks, repositories }: { tasks: Task[]; repositories: Repository[] }) {
  const groups = groupTasksByRepository(selectRunningTasks(tasks), repositories);
  return (
    <section aria-label="Running processes" className="mt-14">
      <h2 className="mb-4 font-mono text-sm font-semibold">Running processes</h2>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No running processes</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.repositoryName} className="rounded-lg border bg-card p-4">
              <h3 className="mb-2 text-sm font-medium">{group.repositoryName}</h3>
              <ul className="flex flex-col gap-2">
                {group.tasks.map((task) => (
                  <RunningTaskRow key={task.id} task={task} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The landing's logged-in sections (connected git hosts + running processes).
 * Rendered only for authenticated visitors, so repos/tasks are only fetched
 * once the session is known to be valid.
 */
export function LoggedInSections() {
  const repositories = useRepositories();
  const tasks = useTasks();
  if (repositories.isPending || tasks.isPending) {
    return (
      <div className="mt-14 flex justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }
  return (
    <>
      <ConnectedHosts repositories={repositories.data ?? []} />
      <RunningProcesses tasks={tasks.data ?? []} repositories={repositories.data ?? []} />
    </>
  );
}
