/**
 * TaskComposer rendering pieces: image attach/thumbnails, the send/save-later
 * buttons, and the ComposerToolbar wiring them together with the toolbar
 * controls from TaskComposerControls.tsx. Extracted from TaskComposer.tsx
 * (AGENTS.md section 2); form state lives in useTaskComposer.ts.
 */
import * as React from 'react';
import { BookmarkPlus, Loader2, Paperclip, Send, X } from 'lucide-react';

import type { TaskImage } from '@/lib/hooks';
import { IMAGE_ACCEPT, MAX_IMAGES } from '@/lib/prompt-composer';
import type { TaskComposerState } from '@/components/console/useTaskComposer';
import {
  ComposerRepoSelect,
  ContextRing,
  FollowUpTaskSelect,
  LlmConfigSelect,
  ThinkingLevelSelect,
} from '@/components/console/TaskComposerControls';
import { LibraryAttachments } from '@/components/library/LibraryAttachments';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

function AttachImagesButton({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: FileList | null) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_ACCEPT}
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
        size="icon"
        variant="ghost"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label="Attach images"
      >
        <Paperclip className="h-4 w-4" aria-hidden />
      </Button>
    </>
  );
}

export function ImageThumbnails({
  images,
  onRemove,
}: {
  images: TaskImage[];
  onRemove: (index: number) => void;
}) {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {images.map((image, index) => (
        <div key={`${image.name}-${index}`} className="relative">
          <img
            src={image.dataUrl}
            alt={image.name}
            title={image.name}
            className="h-12 w-12 rounded-md border object-cover"
          />
          <button
            type="button"
            aria-label={`Remove ${image.name}`}
            onClick={() => onRemove(index)}
            className="absolute -right-1.5 -top-1.5 rounded-full bg-destructive p-0.5 text-destructive-foreground"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

function SendButton({ canSend, pending, onClick }: { canSend: boolean; pending: boolean; onClick: () => void }) {
  return (
    <Button size="icon" onClick={onClick} disabled={!canSend} aria-label="Send prompt">
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Send className="h-4 w-4" aria-hidden />
      )}
    </Button>
  );
}

/** Secondary action: park the prompt as a pending task to start later. */
export function SaveLaterButton({
  canSave,
  pending,
  onClick,
}: {
  canSave: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={onClick}
            disabled={!canSave || pending}
            aria-label="Save prompt for later"
          >
            <BookmarkPlus className="h-4 w-4" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Save for later</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ComposerToolbar({ composer }: { composer: TaskComposerState }) {
  return (
    <div className="flex flex-col gap-2 px-2 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <ComposerRepoSelect
          repositories={composer.repositories}
          repositoryId={composer.repositoryId}
          onChange={composer.setManualRepositoryId}
        />
        <LlmConfigSelect
          configs={composer.enabledConfigs}
          value={composer.llmConfigId}
          onChange={composer.setLlmConfigId}
        />
        <ThinkingLevelSelect value={composer.thinkingLevel} onChange={composer.setThinkingLevel} />
        {composer.repositoryId && (
          <FollowUpTaskSelect
            repositoryId={composer.repositoryId}
            value={composer.followUpTaskId}
            onChange={composer.setFollowUpTaskId}
          />
        )}
        <div className="flex-1" />
        <ContextRing tokens={composer.estimatedTokens} contextWindow={composer.contextWindow} />
      </div>
      <LibraryAttachments
        state={composer.attachments}
        columns
        repositoryId={composer.repositoryId || undefined}
      />
      <div className="flex items-center justify-end gap-2">
        <AttachImagesButton
          disabled={composer.images.length >= MAX_IMAGES}
          onFiles={composer.addImageFiles}
        />
        <SaveLaterButton
          canSave={composer.canSend}
          pending={composer.createTask.isPending}
          onClick={composer.saveLater}
        />
        <SendButton
          canSend={composer.canSend}
          pending={composer.createTask.isPending}
          onClick={composer.submit}
        />
      </div>
    </div>
  );
}
