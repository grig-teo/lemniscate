import * as React from 'react';
import { FileText, Hammer, Loader2, Paperclip } from 'lucide-react';

import { useStartTask, useTask, type Task, type TaskImage } from '@/lib/hooks';
import { appendMarkdownToPrompt, buildStartTaskBody } from '@/lib/proposal-detail';
import { IMAGE_ACCEPT, MAX_IMAGES } from '@/lib/prompt-composer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  appendImageFiles,
  ImageThumbnails,
  useAutoResizeTextarea,
} from '@/components/console/TaskComposer';

// Attach row accepts markdown (content appended into the prompt, separated by
// a blank line) and images (thumbnails, same rules as the task composer).
const MARKDOWN_ACCEPT = '.md,text/markdown';

function DetailMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 px-6 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Hidden file input plus a ghost button that opens it — one per accept kind. */
function AttachFileButton({
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

function ImplementButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <Button size="sm" onClick={onClick} disabled={pending} aria-label="Implement proposal">
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Hammer className="h-4 w-4" aria-hidden />
      )}
      Implement
    </Button>
  );
}

function EditorToolbar({
  images,
  onImageFiles,
  onMarkdownFiles,
  pending,
  onSubmit,
}: {
  images: TaskImage[];
  onImageFiles: (files: FileList | null) => void;
  onMarkdownFiles: (files: FileList | null) => void;
  pending: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <AttachFileButton
        accept={MARKDOWN_ACCEPT}
        label="Attach .md"
        icon={FileText}
        onFiles={onMarkdownFiles}
      />
      <AttachFileButton
        accept={IMAGE_ACCEPT}
        label="Attach image"
        icon={Paperclip}
        disabled={images.length >= MAX_IMAGES}
        onFiles={onImageFiles}
      />
      <div className="flex-1" />
      <ImplementButton pending={pending} onClick={onSubmit} />
    </div>
  );
}

/** Editable title + prompt + attachments; IMPLEMENT queues the proposal with edits. */
function ProposalEditor({ task }: { task: Task }) {
  const startTask = useStartTask();
  const [title, setTitle] = React.useState(task.title);
  const [prompt, setPrompt] = React.useState(task.prompt ?? '');
  const [images, setImages] = React.useState<TaskImage[]>([]);
  const textareaRef = useAutoResizeTextarea(prompt);

  const addImageFiles = (files: FileList | null) => appendImageFiles(files, setImages);
  const removeImage = (index: number) =>
    setImages((prev) => prev.filter((_, i) => i !== index));
  const addMarkdownFiles = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      void file.text().then((content) =>
        setPrompt((prev) => appendMarkdownToPrompt(prev, content)),
      );
    }
  };
  const submit = () => {
    const original = { title: task.title, prompt: task.prompt ?? '' };
    const edited = { title: title.trim(), prompt: prompt.trim(), images };
    startTask.mutate({ id: task.id, body: buildStartTaskBody({ task: original, ...edited }) });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-label="Proposal title"
        className="border-0 px-0 text-base font-medium shadow-none focus-visible:ring-0"
      />
      {startTask.isError && <p className="text-xs text-destructive">{startTask.error.message}</p>}
      <div className="rounded-lg border bg-background shadow-sm focus-within:ring-1 focus-within:ring-ring">
        <ImageThumbnails images={images} onRemove={removeImage} />
        <Textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Proposal prompt…"
          aria-label="Proposal prompt"
          className="resize-none overflow-y-auto border-0 shadow-none focus-visible:ring-0"
        />
      </div>
      <EditorToolbar
        images={images}
        onImageFiles={addImageFiles}
        onMarkdownFiles={addMarkdownFiles}
        pending={startTask.isPending}
        onSubmit={submit}
      />
    </div>
  );
}

/**
 * Detail view for a pending proposal: the full task is fetched for its
 * prompt, then shown as an editable title + auto-growing prompt with a
 * markdown/image attach row. IMPLEMENT posts the edits to
 * POST /api/tasks/:id/start and leaves the task selected — it flips to
 * queued and the normal console view takes over.
 */
export function ProposalDetail({ taskId }: { taskId: string }) {
  const taskQuery = useTask(taskId);

  if (taskQuery.isPending) {
    return (
      <DetailMessage>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading proposal…
      </DetailMessage>
    );
  }
  if (taskQuery.isError) return <DetailMessage>{taskQuery.error.message}</DetailMessage>;
  return <ProposalEditor key={taskQuery.data.id} task={taskQuery.data} />;
}
