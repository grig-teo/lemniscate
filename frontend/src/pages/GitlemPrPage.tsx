import { ArrowLeft, FilePlus2, GitPullRequest, Loader2, Pencil } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { useGitlemPr, type GitlemPrDetail } from '@/lib/hooks';

const STATE_CLASSES: Record<GitlemPrDetail['state'], string> = {
  open: 'border-transparent bg-green-600 text-white',
  merged: 'border-transparent bg-purple-600 text-white',
  closed: 'bg-muted text-muted-foreground',
};

/**
 * Standalone gitlem pull-request page — the target of the internal git
 * host's prUrl (/gitlem/repos/:owner/:repo/pulls/:number) linked from task
 * cards and notifications.
 */
export function GitlemPrPage() {
  const { repo, number } = useParams();
  const prNumber = Number(number);
  const valid = repo !== undefined && Number.isInteger(prNumber) && prNumber > 0;
  const query = useGitlemPr(valid ? repo! : null, valid ? prNumber : null);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 p-6">
      <Link
        to="/dashboard"
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to dashboard
      </Link>
      {!valid || query.isError ? (
        <p className="text-sm text-muted-foreground">Pull request not found.</p>
      ) : query.isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading pull request…
        </div>
      ) : (
        <PrBody pr={query.data.pr} files={query.data.files} />
      )}
    </div>
  );
}

function PrBody({
  pr,
  files,
}: {
  pr: GitlemPrDetail;
  files: { path: string; status: 'added' | 'modified'; headLines: number; baseLines: number }[];
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <GitPullRequest className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h1 className="text-lg font-semibold">
          {pr.title} <span className="text-muted-foreground">#{pr.number}</span>
        </h1>
        <Badge variant="outline" className={STATE_CLASSES[pr.state]}>
          {pr.state}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-mono">{pr.repo}</span>
        {' · '}
        <span className="font-mono">{pr.head}</span> → <span className="font-mono">{pr.base}</span>
        {' · '}opened {new Date(pr.createdAt).toLocaleString()}
      </p>
      {pr.body && (
        <div className="rounded-md border p-3">
          <p className="whitespace-pre-wrap text-sm">{pr.body}</p>
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Changed files ({files.length})
        </span>
        {files.length === 0 ? (
          <p className="text-xs text-muted-foreground">No file changes.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {files.map((file) => (
              <li key={file.path} className="flex items-center gap-2 text-xs">
                {file.status === 'added' ? (
                  <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-green-600" aria-hidden />
                ) : (
                  <Pencil className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
                )}
                <span className="truncate font-mono">{file.path}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {file.status === 'added' ? 'added' : `${file.baseLines} → ${file.headLines} lines`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
