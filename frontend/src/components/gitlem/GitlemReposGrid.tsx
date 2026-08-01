import * as React from 'react';
import { Loader2, Plus, X } from 'lucide-react';

import { CreateRepoDialog } from '@/components/repo-tree/CreateRepoDialog';
import { Button } from '@/components/ui/button';
import { useConnections, useEnsureGitlemAccount, useGitlemRepos } from '@/lib/hooks';
import { useWorkspaceSelection } from '@/lib/selection';

/**
 * Center-pane grid of the signed-in user's gitlem repositories. Opened from
 * the top-nav gitlem icon; a "+" card opens the create-repo dialog preset to
 * the gitlem connection, auto-provisioning a gitlem account first when none
 * exists. Clicking a repo opens its detail view.
 */
export function GitlemReposGrid() {
  const { closeGitlemView, openGitlemRepo } = useWorkspaceSelection();
  const repos = useGitlemRepos();
  const [createOpen, setCreateOpen] = React.useState(false);
  const onCreate = useEnsureBeforeCreate(() => setCreateOpen(true));
  const gitlemConn = onCreate.gitlemConnectionId;

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Gitlem repositories</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          aria-label="Close gitlem view"
          title="Close gitlem view"
          onClick={closeGitlemView}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {onCreate.error && (
        <p className="px-4 py-2 text-sm text-destructive">{onCreate.error}</p>
      )}

      <GitlemGridBody
        repos={repos}
        onOpenRepo={openGitlemRepo}
        onCreate={onCreate.create}
        creating={onCreate.pending}
      />

      {gitlemConn && (
        <CreateRepoDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          presetConnectionId={gitlemConn}
        />
      )}
    </section>
  );
}

function GitlemGridBody({
  repos,
  onOpenRepo,
  onCreate,
  creating,
}: {
  repos: ReturnType<typeof useGitlemRepos>;
  onOpenRepo: (name: string) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  if (repos.isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading gitlem repositories…
      </div>
    );
  }
  const list = repos.data ?? [];
  return (
    <div className="grid grid-cols-1 gap-3 overflow-y-auto p-4 sm:grid-cols-2 lg:grid-cols-3">
      {list.map((repo) => (
        <button
          key={repo.id}
          type="button"
          onClick={() => onOpenRepo(repo.name)}
          className="flex flex-col gap-1 rounded-md border bg-card p-4 text-left transition hover:border-primary/50 hover:shadow-sm"
        >
          <span className="truncate font-medium">{repo.name}</span>
          <span className="truncate text-xs text-muted-foreground">{repo.fullName}</span>
          <span className="text-xs text-muted-foreground">default: {repo.defaultBranch}</span>
        </button>
      ))}
      <CreateRepoCard onCreate={onCreate} creating={creating} />
    </div>
  );
}

function CreateRepoCard({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <button
      type="button"
      onClick={onCreate}
      disabled={creating}
      className="flex min-h-[96px] items-center justify-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground transition hover:border-primary/50 hover:text-foreground disabled:opacity-50"
    >
      {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
      {creating ? 'Preparing…' : 'New gitlem repository'}
    </button>
  );
}

/**
 * Guards the create flow: a gitlem connection must exist before the
 * create-repo dialog can be preset to it. When none exists, POST /api/gitlem/ensure
 * provisions one (the backend checks first and only creates when absent).
 */
function useEnsureBeforeCreate(after: () => void) {
  const { data: connections } = useConnections();
  const ensure = useEnsureGitlemAccount();
  const gitlemConnection = connections?.find((c) => c.provider === 'gitlem');

  const create = React.useCallback(() => {
    if (gitlemConnection) {
      after();
      return;
    }
    ensure.mutate(undefined, { onSuccess: () => after() });
  }, [gitlemConnection, ensure, after]);

  return {
    create,
    pending: ensure.isPending,
    error: ensure.isError ? ensure.error.message : null,
    gitlemConnectionId: gitlemConnection?.id,
  };
}
