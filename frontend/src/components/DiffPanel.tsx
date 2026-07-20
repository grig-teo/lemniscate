import * as React from 'react';
import { FileDiff, FilePlus2, PanelRightClose, PanelRightOpen } from 'lucide-react';

import { useWorkspaceSelection } from '@/lib/selection';
import {
  diffLineClass,
  normalizeDiffEvents,
  type FileGroup,
  type PatchEntry,
  type WriteEntry,
} from '@/lib/event-payload';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

function EmptyDiffState() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <FileDiff className="h-8 w-8 text-muted-foreground/50" aria-hidden />
      <p className="text-sm text-muted-foreground">Nothing to review yet.</p>
      <p className="text-xs text-muted-foreground/70">
        When the agent proposes changes, the diff appears here for review.
      </p>
    </div>
  );
}

function WriteEntryRow({ entry, path }: { entry: WriteEntry; path: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 text-zinc-300">
      <FilePlus2 className="h-3 w-3 shrink-0 text-zinc-500" aria-hidden />
      {entry.action} {path}
    </div>
  );
}

function PatchLines({ entry, entryIndex }: { entry: PatchEntry; entryIndex: number }) {
  return (
    <>
      {entry.lines.map((line, lineIndex) => (
        <pre
          key={`${entryIndex}-${lineIndex}`}
          className={cn('whitespace-pre-wrap break-all px-2', diffLineClass(line))}
        >
          {line || ' '}
        </pre>
      ))}
    </>
  );
}

function FileGroupCard({ group }: { group: FileGroup }) {
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="border-b bg-muted px-2 py-1 font-mono text-xs font-medium">{group.path}</div>
      <div className="bg-zinc-950 font-mono text-[11px] leading-4">
        {group.entries.map((entry, index) =>
          entry.kind === 'write' ? (
            <WriteEntryRow key={index} entry={entry} path={group.path} />
          ) : (
            <PatchLines key={index} entry={entry} entryIndex={index} />
          ),
        )}
      </div>
    </div>
  );
}

function PanelToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? 'Show diff panel' : 'Hide diff panel';
  const Icon = collapsed ? PanelRightOpen : PanelRightClose;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onToggle} aria-label={label}>
            <Icon className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * RIGHT pane — code / diff viewer, collapsible.
 *
 * Renders the diff events forwarded from the selected task's event stream,
 * grouped by file path with line-level coloring, plus file-write events as
 * "created/modified <path>" entries.
 */
export function DiffPanel() {
  const { diffEvents } = useWorkspaceSelection();
  const [collapsed, setCollapsed] = React.useState(false);

  const groups = React.useMemo(() => normalizeDiffEvents(diffEvents), [diffEvents]);

  if (collapsed) {
    return (
      <aside className="flex h-full w-10 shrink-0 flex-col items-center border-l bg-card py-2">
        <PanelToggle collapsed onToggle={() => setCollapsed(false)} />
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-96 shrink-0 flex-col border-l bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Code / Diff
        </span>
        <PanelToggle collapsed={false} onToggle={() => setCollapsed(true)} />
      </div>

      <ScrollArea className="flex-1">
        {groups.length === 0 ? (
          <EmptyDiffState />
        ) : (
          <div className="flex flex-col gap-3 p-3">
            {groups.map((group) => (
              <FileGroupCard key={group.path} group={group} />
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  );
}
