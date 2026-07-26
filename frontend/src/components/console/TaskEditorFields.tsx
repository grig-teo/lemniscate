/**
 * Presentational pieces of the proposal/task editor (extracted from
 * ProposalDetail.tsx per AGENTS.md section 2): the Preview/Edit toggle row,
 * the Improve button, the prompt preview, the drag-to-resize handle logic,
 * and the hidden-file-input attach button.
 */
import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { Task } from '@/lib/hooks';
import { MarkdownView } from '@/components/MarkdownView';
import { Button } from '@/components/ui/button';

/** Task row plus the library-attachment columns returned by GET /api/tasks/:id. */
export type TaskWithAttachments = Task & {
  skills?: unknown;
  mcpServers?: unknown;
  agentsMdFiles?: unknown;
};

export function DetailMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 px-6 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground',
        active && 'bg-accent font-medium text-foreground',
      )}
    >
      {label}
    </button>
  );
}

/** Segmented Preview/Edit toggle for the prompt field. */
export function ViewToggle({
  preview,
  onChange,
  action,
}: {
  preview: boolean;
  onChange: (preview: boolean) => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
      <ToggleButton active={preview} onClick={() => onChange(true)} label="Preview" />
      <ToggleButton active={!preview} onClick={() => onChange(false)} label="Edit" />
      <div className="flex-1" />
      {action}
    </div>
  );
}

/** Improve button on the right of the Preview/Edit row: asks the LLM to
 *  rewrite the current prompt into the structured proposal-document shape. */
export function ImproveButton({
  pending,
  disabled,
  onClick,
}: {
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      className={cn(
        'flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground',
        'hover:text-foreground disabled:opacity-50',
      )}
    >
      {pending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {pending ? 'Improving…' : 'Improve'}
    </button>
  );
}

/** Prompt rendered as markdown, or the plain-text fallback for an empty prompt. */
export function PromptPreview({ prompt }: { prompt: string }) {
  if (!prompt.trim()) {
    return <p className="text-sm text-muted-foreground">Nothing to preview.</p>;
  }
  return <MarkdownView>{prompt}</MarkdownView>;
}

const PROMPT_MIN_HEIGHT = 140;
const PROMPT_MAX_RATIO = 0.8;

/** Window-level vertical drag: reports the clamped px height on each move. */
function beginHeightDrag(
  event: React.MouseEvent,
  startHeight: number,
  maxHeight: number,
  onHeight: (height: number) => void,
) {
  event.preventDefault();
  const startY = event.clientY;
  const onMove = (e: MouseEvent) =>
    onHeight(
      Math.min(maxHeight, Math.max(PROMPT_MIN_HEIGHT, Math.round(startHeight + e.clientY - startY))),
    );
  const stop = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', stop);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', stop);
}

/** Drag-to-resize state for the prompt field; null height = the CSS default. */
export function useResizablePrompt() {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState<number | null>(null);
  const startDrag = (event: React.MouseEvent) => {
    const startHeight = boxRef.current?.getBoundingClientRect().height ?? 0;
    const paneHeight = boxRef.current?.parentElement?.getBoundingClientRect().height ?? 0;
    beginHeightDrag(event, startHeight, paneHeight * PROMPT_MAX_RATIO, setHeight);
  };
  return { boxRef, height, startDrag };
}

/** Hidden file input plus a ghost button that opens it — one per accept kind. */
export function AttachFileButton({
  accept,
  label,
  icon: Icon,
  disabled,
  onFiles,
}: {
  accept: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  onFiles: (files: FileList | null) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        className="hidden"
        aria-hidden
        onChange={(event) => {
          onFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Icon className="h-4 w-4" aria-hidden />
        {label}
      </Button>
    </>
  );
}
