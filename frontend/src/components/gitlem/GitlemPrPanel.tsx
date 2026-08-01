import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { useGitlemPrs } from '@/lib/hooks';

/** Open pull requests for the gitlem repository (newest number first). */
export function GitlemPrPanel({ name }: { name: string }) {
  const prs = useGitlemPrs(name);
  const list = prs.data ?? [];

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Open pull requests
      </span>
      {prs.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading pull requests…
        </div>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">No open pull requests.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {list.map((pr) => (
            <li key={pr.number} className="flex items-center gap-2 text-xs">
              <Badge variant="outline">#{pr.number}</Badge>
              <span className="truncate">{pr.title}</span>
              <span className="ml-auto shrink-0 font-mono text-muted-foreground">
                {pr.head} → {pr.base}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
