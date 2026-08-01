import { Loader2, X } from 'lucide-react';

import { GitlemBranchBar } from '@/components/gitlem/GitlemBranchBar';
import { GitlemReadmePanel } from '@/components/gitlem/GitlemReadmePanel';
import { GitlemCloneBar } from '@/components/gitlem/GitlemCloneBar';
import { GitlemCiPanel } from '@/components/gitlem/GitlemCiPanel';
import { GitlemPrPanel } from '@/components/gitlem/GitlemPrPanel';
import { Button } from '@/components/ui/button';
import { useGitlemRepoDetail } from '@/lib/hooks';
import { useWorkspaceSelection } from '@/lib/selection';
import * as React from 'react';

/**
 * Center-pane detail view for one gitlem repository: a branch switcher, the
 * scrollable README, the clone URL, recent CI runs (with a trigger), and the
 * open pull requests. Closed back to the gitlem grid.
 */
export function GitlemRepoDetail({ name }: { name: string }) {
  const { closeGitlemView } = useWorkspaceSelection();
  const detail = useGitlemRepoDetail(name);
  const [branch, setBranch] = React.useState<string | null>(null);

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {detail.data?.fullName ?? name}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          aria-label="Close gitlem detail"
          title="Back to gitlem repositories"
          onClick={closeGitlemView}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {detail.isLoading ? (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading repository…
        </div>
      ) : detail.isError ? (
        <p className="px-4 py-3 text-sm text-destructive">{detail.error.message}</p>
      ) : (
        <GitlemRepoBody name={name} detail={detail.data!} branch={branch} setBranch={setBranch} />
      )}
    </section>
  );
}

function GitlemRepoBody({
  name,
  detail,
  branch,
  setBranch,
}: {
  name: string;
  detail: NonNullable<ReturnType<typeof useGitlemRepoDetail>['data']>;
  branch: string | null;
  setBranch: (b: string | null) => void;
}) {
  const activeBranch = branch ?? detail.defaultBranch;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <GitlemBranchBar
        branches={detail.branches}
        defaultBranch={detail.defaultBranch}
        active={activeBranch}
        onChange={setBranch}
        repoName={name}
      />
      <GitlemCloneBar cloneUrl={detail.cloneUrl} />
      <GitlemReadmePanel name={name} branch={activeBranch} />
      <GitlemCiPanel name={name} branch={activeBranch} />
      <GitlemPrPanel name={name} />
    </div>
  );
}
