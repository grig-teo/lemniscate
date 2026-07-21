import * as React from 'react';
import { Loader2, Paperclip, Plus, Send, X } from 'lucide-react';

import { defaultRepositoryId } from '@/lib/default-repository';
import {
  useCreateTask,
  useLlmConfigs,
  useRepositories,
  type LlmConfig,
  type Repository,
  type TaskImage,
  type TaskThinkingLevel,
} from '@/lib/hooks';
import {
  clampTextareaHeight,
  estimateTokens,
  IMAGE_ACCEPT,
  isAcceptedImage,
  MAX_IMAGES,
  resolveContextWindow,
  ringTone,
  type RingTone,
} from '@/lib/prompt-composer';
import { ProviderIcon } from '@/lib/providers';
import { useWorkspaceSelection } from '@/lib/selection';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// Auto-growing textarea bounds: ~3 rows initially, up to ~5 rows, then the
// textarea scrolls internally (overflow-y-auto).
const TEXTAREA_LINE_HEIGHT_PX = 20; // text-sm line-height
const TEXTAREA_VERTICAL_PADDING_PX = 16; // py-2, top + bottom
const TEXTAREA_MIN_ROWS = 3;
const TEXTAREA_MAX_ROWS = 5;
const TEXTAREA_MIN_HEIGHT =
  TEXTAREA_MIN_ROWS * TEXTAREA_LINE_HEIGHT_PX + TEXTAREA_VERTICAL_PADDING_PX;
const TEXTAREA_MAX_HEIGHT =
  TEXTAREA_MAX_ROWS * TEXTAREA_LINE_HEIGHT_PX + TEXTAREA_VERTICAL_PADDING_PX;

/** Grows the textarea with its content, clamped to the min/max row bounds. */
export function useAutoResizeTextarea(value: string) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${clampTextareaHeight(el.scrollHeight, TEXTAREA_MIN_HEIGHT, TEXTAREA_MAX_HEIGHT)}px`;
  }, [value]);
  return ref;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** Read accepted image files as data URLs and append them, capped at MAX_IMAGES. */
export function appendImageFiles(
  files: FileList | null,
  setImages: React.Dispatch<React.SetStateAction<TaskImage[]>>,
) {
  if (!files) return;
  const accepted = Array.from(files).filter(isAcceptedImage);
  for (const file of accepted) {
    void readFileAsDataUrl(file).then((dataUrl) => {
      setImages((prev) =>
        prev.length >= MAX_IMAGES ? prev : [...prev, { name: file.name, dataUrl }],
      );
    });
  }
}

/** Composer state: repo choice (defaults follow the selected task), prompt, submit. */
function useTaskComposer(onSubmitted?: () => void) {
  const repositoriesQuery = useRepositories();
  const llmConfigsQuery = useLlmConfigs();
  const createTask = useCreateTask();
  const { selectedTask, selectTask } = useWorkspaceSelection();
  const repositories = repositoriesQuery.data ?? [];
  const llmConfigs = llmConfigsQuery.data ?? [];
  const [manualRepositoryId, setManualRepositoryId] = React.useState<string | null>(null);
  const [prompt, setPrompt] = React.useState('');
  const [thinkingLevel, setThinkingLevel] = React.useState<TaskThinkingLevel | null>(null);
  const [llmConfigId, setLlmConfigId] = React.useState<string | null>(null);
  const [images, setImages] = React.useState<TaskImage[]>([]);

  const manualChoiceValid = repositories.some((repo) => repo.id === manualRepositoryId);
  const repositoryId = manualChoiceValid
    ? (manualRepositoryId as string)
    : defaultRepositoryId(repositories, selectedTask);
  const enabledConfigs = llmConfigs.filter((config) => config.enabled);

  const canSend =
    repositories.length > 0 &&
    Boolean(repositoryId) &&
    prompt.trim().length > 0 &&
    !createTask.isPending;

  const estimatedTokens = estimateTokens(prompt);
  const contextWindow = resolveContextWindow(llmConfigs, repositories, repositoryId, llmConfigId);

  const addImageFiles = (files: FileList | null) => appendImageFiles(files, setImages);

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const submit = () => {
    if (!canSend) return;
    createTask.mutate(
      {
        repositoryId,
        prompt: prompt.trim(),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(llmConfigId ? { llmConfigId } : {}),
        ...(images.length > 0 ? { images } : {}),
      },
      {
        onSuccess: (task) => {
          selectTask({
            id: task.id,
            title: task.title,
            status: task.status,
            kind: task.kind,
            repositoryId: task.repositoryId,
          });
          setPrompt('');
          setImages([]);
          onSubmitted?.();
        },
      },
    );
  };

  return {
    repositories,
    repositoryId,
    setManualRepositoryId,
    prompt,
    setPrompt,
    thinkingLevel,
    setThinkingLevel,
    llmConfigId,
    setLlmConfigId,
    enabledConfigs,
    images,
    addImageFiles,
    removeImage,
    estimatedTokens,
    contextWindow,
    canSend,
    createTask,
    submit,
  };
}

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

function submitOnCmdEnter(event: React.KeyboardEvent<HTMLTextAreaElement>, submit: () => void) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    submit();
  }
}

function ComposerToolbar({ composer }: { composer: ReturnType<typeof useTaskComposer> }) {
  return (
    <div className="flex flex-nowrap items-center gap-2 px-2 pb-2">
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
      <AttachImagesButton
        disabled={composer.images.length >= MAX_IMAGES}
        onFiles={composer.addImageFiles}
      />
      <SendButton
        canSend={composer.canSend}
        pending={composer.createTask.isPending}
        onClick={composer.submit}
      />
    </div>
  );
}

/**
 * Modal composer that starts a new prompt task on a chosen repository and
 * selects it. The auto-growing textarea sits on top and submits on
 * Cmd/Ctrl+Enter or the send button; the toolbar under it carries the repo
 * picker, per-prompt thinking level, a context-usage ring, and image
 * attachments. Closes on successful submit.
 */
export function TaskComposerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const composer = useTaskComposer(() => onOpenChange(false));
  const textareaRef = useAutoResizeTextarea(composer.prompt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            The agent clones the selected repository, implements your task, and opens a pull
            request.
          </DialogDescription>
        </DialogHeader>
        {composer.createTask.isError && (
          <p className="text-xs text-destructive">{composer.createTask.error.message}</p>
        )}
        <div className="rounded-lg border bg-background shadow-sm focus-within:ring-1 focus-within:ring-ring">
          <ImageThumbnails images={composer.images} onRemove={composer.removeImage} />
          <Textarea
            ref={textareaRef}
            value={composer.prompt}
            onChange={(event) => composer.setPrompt(event.target.value)}
            onKeyDown={(event) => submitOnCmdEnter(event, composer.submit)}
            placeholder="Describe a task for the agent… (⌘/Ctrl+Enter to send)"
            rows={TEXTAREA_MIN_ROWS}
            aria-label="Prompt"
            className="resize-none overflow-y-auto border-0 shadow-none focus-visible:ring-0"
          />
          <ComposerToolbar composer={composer} />
        </div>
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
