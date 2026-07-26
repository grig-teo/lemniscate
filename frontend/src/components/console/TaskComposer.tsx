/**
 * TaskComposer shell: the shared composer card (auto-growing textarea +
 * toolbar) used by both the modal TaskComposerDialog and the inline
 * empty-console composer, plus the floating '+' trigger. Form state lives in
 * useTaskComposer.ts, rendering pieces in TaskComposerFields.tsx, helpers in
 * composer-utils.ts.
 */
import * as React from 'react';
import { Plus } from 'lucide-react';

import {
  submitOnCmdEnter,
  TEXTAREA_MIN_ROWS,
  useAutoResizeTextarea,
} from '@/components/console/composer-utils';
import { ComposerToolbar, ImageThumbnails } from '@/components/console/TaskComposerFields';
import { useTaskComposer } from '@/components/console/useTaskComposer';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const DEFAULT_PLACEHOLDER = 'Describe a task for the agent… (⌘/Ctrl+Enter to send)';
const BARE_PLACEHOLDER = 'Describe your app idea… (⌘/Ctrl+Enter to send)';
/** Inviting line shown above the textarea when the target repo is near-empty (README-only). */
const BARE_REPO_MESSAGE =
  'This repository is almost empty — describe the app you want to build and the agent will create the first implementation.';

/**
 * Shared composer card (auto-growing textarea + toolbar) used by both the
 * modal TaskComposerDialog and the inline empty-console composer — one
 * implementation, no duplication. Submits on Cmd/Ctrl+Enter or the send
 * button; `onSubmitted` runs after a task is sent (the dialog closes on it).
 */
export function ComposerCard({ onSubmitted }: { onSubmitted?: () => void }) {
  const composer = useTaskComposer(onSubmitted);
  const textareaRef = useAutoResizeTextarea(composer.prompt);
  const bare = composer.repository?.bare === true;

  return (
    <div className="flex flex-col gap-2">
      {composer.createTask.isError && (
        <p className="text-xs text-destructive">{composer.createTask.error.message}</p>
      )}
      {bare && <p className="text-xs text-muted-foreground">{BARE_REPO_MESSAGE}</p>}
      <div className="rounded-lg border bg-background shadow-sm focus-within:ring-1 focus-within:ring-ring">
        <ImageThumbnails images={composer.images} onRemove={composer.removeImage} />
        <Textarea
          ref={textareaRef}
          value={composer.prompt}
          onChange={(event) => composer.setPrompt(event.target.value)}
          onKeyDown={(event) => submitOnCmdEnter(event, composer.submit)}
          placeholder={bare ? BARE_PLACEHOLDER : DEFAULT_PLACEHOLDER}
          rows={TEXTAREA_MIN_ROWS}
          aria-label="Prompt"
          className="resize-none overflow-y-auto border-0 shadow-none focus-visible:ring-0"
        />
        <ComposerToolbar composer={composer} />
      </div>
    </div>
  );
}

/**
 * Modal composer that starts a new prompt task on a chosen repository and
 * selects it. Closes on successful submit; the card itself is ComposerCard.
 */
export function TaskComposerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto overflow-x-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            The agent clones the selected repository, implements your task, and opens a pull
            request.
          </DialogDescription>
        </DialogHeader>
        <ComposerCard onSubmitted={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Floating round '+' trigger at the bottom-right of the console pane. */
export function TaskComposerFab() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              onClick={() => setOpen(true)}
              aria-label="New task"
              className="absolute bottom-4 right-4 z-10 h-11 w-11 rounded-full shadow-lg"
            >
              <Plus className="h-5 w-5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">New task</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <TaskComposerDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
