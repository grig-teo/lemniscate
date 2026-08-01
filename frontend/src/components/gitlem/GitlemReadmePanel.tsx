import { FileText, Loader2 } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { useGitlemReadme } from '@/lib/hooks';

/**
 * Vertically scrollable README viewer for one gitlem branch. Rendered as
 * preformatted text (whitespace preserved) so indentation/tables survive
 * without a markdown dependency. A 404 (no README on the branch) shows a
 * placeholder instead of an error.
 */
export function GitlemReadmePanel({ name, branch }: { name: string; branch: string }) {
  const readme = useGitlemReadme(name, branch);
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-md border">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <FileText className="h-3.5 w-3.5" aria-hidden /> README — {branch}
      </div>
      {readme.isLoading ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading README…
        </div>
      ) : readme.isError || !readme.data ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          No README on this branch.
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed">
            {readme.data.content}
          </pre>
        </ScrollArea>
      )}
    </div>
  );
}
