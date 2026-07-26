/**
 * TaskComposer rendering pieces: the toolbar selects (repository, model,
 * thinking level), the context-usage ring, image attach/thumbnails, and the
 * send/save-later buttons. Extracted from TaskComposer.tsx (AGENTS.md
 * section 2); form state lives in useTaskComposer.ts.
 */
import * as React from 'react';
import { Loader2, Paperclip, Send, X } from 'lucide-react';

import type { LlmConfig, Repository, TaskImage, TaskThinkingLevel } from '@/lib/hooks';
import {
  IMAGE_ACCEPT,
  MAX_IMAGES,
  ringTone,
  type RingTone,
} from '@/lib/prompt-composer';
import { ProviderIcon } from '@/lib/providers';
import type { TaskComposerState } from '@/components/console/useTaskComposer';
import { LibraryAttachments } from '@/components/library/LibraryAttachments';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

function ComposerRepoSelect({
  repositories,
  repositoryId,
  onChange,
}: {
  repositories: Repository[];
  repositoryId: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select value={repositoryId} onValueChange={onChange} disabled={repositories.length === 0}>
      <SelectTrigger className="h-8 w-40 shrink-0" aria-label="Repository">
        <SelectValue placeholder="Select a repository…" />
      </SelectTrigger>
      <SelectContent>
        {repositories.map((repo) => (
          <SelectItem key={repo.id} value={repo.id}>
            <span className="flex items-center gap-2">
              <ProviderIcon provider={repo.connection.provider} className="h-3.5 w-3.5" />
              <span className="truncate">{repo.fullName}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function LlmConfigSelect({
  configs,
  value,
  onChange,
}: {
  configs: LlmConfig[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <Select
      value={value ?? 'default'}
      onValueChange={(v) => onChange(v === 'default' ? null : v)}
      disabled={configs.length === 0}
    >
      <SelectTrigger className="h-8 w-40 shrink-0" aria-label="Model">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Default model</SelectItem>
        {configs.map((config) => (
          <SelectItem key={config.id} value={config.id}>
            <span className="truncate">
              {config.name} · {config.model}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ThinkingLevelSelect({
  value,
  onChange,
}: {
  value: TaskThinkingLevel | null;
  onChange: (level: TaskThinkingLevel | null) => void;
}) {
  return (
    <Select
      value={value ?? 'default'}
      onValueChange={(v) => onChange(v === 'default' ? null : (v as TaskThinkingLevel))}
    >
      <SelectTrigger className="h-8 w-28 shrink-0" aria-label="Thinking level">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Default</SelectItem>
        <SelectItem value="low">Low</SelectItem>
        <SelectItem value="medium">Medium</SelectItem>
        <SelectItem value="high">High</SelectItem>
        <SelectItem value="max">Max</SelectItem>
      </SelectContent>
    </Select>
  );
}

const RING_TONE_CLASS: Record<RingTone, string> = {
  muted: 'stroke-muted-foreground',
  amber: 'stroke-amber-500',
  red: 'stroke-destructive',
};

/** Circular gauge of the estimated prompt-token share of the context window. */
function ContextRing({ tokens, contextWindow }: { tokens: number; contextWindow: number | null }) {
  if (contextWindow === null || contextWindow <= 0) return null;
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const ratio = tokens / contextWindow;
  const filled = Math.min(1, ratio) * circumference;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <svg
            width={20}
            height={20}
            viewBox="0 0 20 20"
            role="img"
            aria-label="Estimated context usage"
            className="shrink-0"
          >
            <circle cx={10} cy={10} r={radius} fill="none" strokeWidth={2.5} className="stroke-muted" />
            <circle
              cx={10}
              cy={10}
              r={radius}
              fill="none"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray={`${filled} ${circumference}`}
              transform="rotate(-90 10 10)"
              className={RING_TONE_CLASS[ringTone(ratio)]}
            />
          </svg>
        </TooltipTrigger>
        <TooltipContent>
          ≈{tokens.toLocaleString()} tokens of {contextWindow.toLocaleString()}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

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
function SaveLaterButton({
  canSave,
  pending,
  onClick,
}: {
  canSave: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onClick}
      disabled={!canSave || pending}
      aria-label="Save prompt for later"
    >
      Save for later
    </Button>
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
