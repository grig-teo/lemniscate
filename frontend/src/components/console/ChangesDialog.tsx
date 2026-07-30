import * as React from 'react';
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react';

import {
  countDiffHunkLines,
  parseDiffLines,
  type ChangeSummary,
  type DiffLine,
  type FileChange,
} from '@/lib/session-changes';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Totals of one file across the diffs the dialog renders for it. */
function changeTotals(change: FileChange): { added: number; removed: number } {
  const base = countDiffHunkLines(change.baseDiff);
  const head = countDiffHunkLines(change.diff);
  return { added: base.added + head.added, removed: base.removed + head.removed };
}

const ACTION_LABEL: Record<string, string> = {
  created: 'A',
  modified: 'M',
  deleted: 'D',
};

const ACTION_CLASS: Record<string, string> = {
  created: 'text-green-600 dark:text-green-400',
  modified: 'text-amber-600 dark:text-amber-400',
  deleted: 'text-red-600 dark:text-red-400',
};

function ActionBadge({ action }: { action: string }) {
  const label = ACTION_LABEL[action] ?? 'M';
  return (
    <span
      className={cn('w-4 shrink-0 text-center font-semibold', ACTION_CLASS[action])}
      title={action}
    >
      {label}
    </span>
  );
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px]">
      <span className="text-green-600 dark:text-green-400">+{added}</span>{' '}
      <span className="text-red-600 dark:text-red-400">−{removed}</span>
    </span>
  );
}

const DIFF_LINE_CLASS: Record<DiffLine['kind'], string> = {
  add: 'bg-green-500/10 text-green-700 dark:text-green-300',
  del: 'bg-red-500/10 text-red-700 dark:text-red-300',
  ctx: 'text-zinc-600 dark:text-zinc-400',
  hunk: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  meta: 'text-zinc-400 dark:text-zinc-500',
};

function DiffLineRow({ line }: { line: DiffLine }) {
  const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'ctx' ? ' ' : '';
  return (
    <div className={cn('whitespace-pre-wrap break-all px-3', DIFF_LINE_CLASS[line.kind])}>
      {line.kind === 'hunk' || line.kind === 'meta' ? line.text || ' ' : `${prefix}${line.text}`}
    </div>
  );
}

export function FileChangeRow({ change }: { change: FileChange }) {
  const [open, setOpen] = React.useState(false);
  const totals = changeTotals(change);
  const lines = React.useMemo(() => (open ? parseDiffLines(change) : []), [open, change]);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="overflow-hidden rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-muted/40 px-3 py-1.5 text-left text-xs hover:bg-muted/70"
      >
        <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <ActionBadge action={change.action} />
        <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
        <DiffStat added={totals.added} removed={totals.removed} />
      </button>
      {open && (
        <div className="border-t py-1 font-mono text-[11px] leading-5">
          {lines.map((line, i) => (
            <DiffLineRow key={i} line={line} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SummaryBar({ summary }: { summary: ChangeSummary }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <FileDiff className="h-3.5 w-3.5" aria-hidden />
      <span>
        {summary.count} {summary.count === 1 ? 'file' : 'files'} changed
      </span>
      <DiffStat added={summary.additions} removed={summary.deletions} />
    </div>
  );
}

/**
 * GitHub-style changes view for the current agent session: a summary bar
 * (files changed, +/− totals) and one collapsible diff block per file.
 * Opened from the console header by clicking the branch badge or the
 * changes count next to it.
 */
export function ChangesDialog({
  open,
  onOpenChange,
  branchName,
  summary,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branchName: string | null;
  summary: ChangeSummary;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            Changes
            {branchName && (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-normal">
                {branchName}
              </code>
            )}
          </DialogTitle>
          <DialogDescription>
            Files the agent touched in this session, newest diff per file.
          </DialogDescription>
        </DialogHeader>
        <SummaryBar summary={summary} />
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
          {summary.changes.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No file changes recorded yet.
            </p>
          )}
          {summary.changes.map((change) => (
            <FileChangeRow key={change.path} change={change} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
