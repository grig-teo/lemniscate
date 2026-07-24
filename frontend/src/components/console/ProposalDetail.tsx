import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Hammer, Loader2, Paperclip, Save } from 'lucide-react';

import { api } from '@/lib/api';
import {
  appendMarkdownToPrompt,
  buildTaskEditBody,
  taskAgentsMdInitial,
  taskMcpSelections,
  taskSkillSelections,
} from '@/lib/proposal-detail';
import { useSkills, useStartTask, useTask, type Task, type TaskImage } from '@/lib/hooks';
import { useLibraryAttachments } from '@/lib/library-attachments';
import { IMAGE_ACCEPT, MAX_IMAGES } from '@/lib/prompt-composer';
import { LibraryAttachments } from '@/components/library/LibraryAttachments';
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

/** Task row plus the library-attachment columns returned by GET /api/tasks/:id. */
type TaskWithAttachments = Task & {
  skills?: unknown;
  mcpServers?: unknown;
  agentsMdFiles?: unknown;
};

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

/** PATCH /api/tasks/:id — save edits on a pending task without starting it. */
function usePatchTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) =>
      api.patch(`/api/tasks/${id}`, body as Record<string, unknown>),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['task'] });
    },
  });
}

/** Resolves skill display names, then mounts the editor with them prefilled. */
function TaskEditorWithSkillNames({ task }: { task: TaskWithAttachments }) {
  const skillsQuery = useSkills('');
  if (skillsQuery.isPending) {
    return (
      <DetailMessage>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading skills…
      </DetailMessage>
    );
  }
  const initialSkills = taskSkillSelections(task.skills, skillsQuery.data ?? []);
  return <TaskEditorInner key={task.id} task={task} initialSkills={initialSkills} />;
}

// Inner editor keyed by task id: prefilled selection maps are mount-time state.
function TaskEditorInner({
  task,
  initialSkills,
}: {
  task: TaskWithAttachments;
  initialSkills: ReadonlyMap<string, string>;
}) {
  const startTask = useStartTask();
  const patchTask = usePatchTask();
  const [title, setTitle] = React.useState(task.title);
  const [prompt, setPrompt] = React.useState(task.prompt ?? '');
  const [images, setImages] = React.useState<TaskImage[]>([]);
  const [saved, setSaved] = React.useState(false);
  const textareaRef = useAutoResizeTextarea(prompt);
  const attachments = useLibraryAttachments({
    skills: initialSkills,
    mcpServers: taskMcpSelections(task.mcpServers),
    agentsMd: taskAgentsMdInitial(task.agentsMdFiles),
  });

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

  const editBody = () =>
    buildTaskEditBody({
      task: { title: task.title, prompt: task.prompt ?? '' },
      title: title.trim(),
      prompt: prompt.trim(),
      images,
      selections: {
        skillSlugs: attachments.skills.slugs,
        mcpServerSlugs: attachments.mcpServers.slugs,
        agentsMdFiles: attachments.agentsMd.toAssignments(),
      },
    });

  const save = () => {
    setSaved(false);
    patchTask.mutate({ id: task.id, body: editBody() }, { onSuccess: () => setSaved(true) });
  };
  const start = () => startTask.mutate({ id: task.id, body: editBody() });
  const actionError = startTask.error ?? patchTask.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-label="Task title"
        className="border-0 px-0 text-base font-medium shadow-none focus-visible:ring-0"
      />
      {actionError && <p className="text-xs text-destructive">{actionError.message}</p>}
      <div className="rounded-lg border bg-background shadow-sm focus-within:ring-1 focus-within:ring-ring">
        <ImageThumbnails images={images} onRemove={removeImage} />
        <Textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Prompt…"
          aria-label="Task prompt"
          className="resize-none overflow-y-auto border-0 shadow-none focus-visible:ring-0"
        />
      </div>
      <div className="flex items-center gap-2">
        <AttachFileButton
          accept={MARKDOWN_ACCEPT}
          label="Attach .md"
          icon={FileText}
          onFiles={addMarkdownFiles}
        />
        <AttachFileButton
          accept={IMAGE_ACCEPT}
          label="Attach image"
          icon={Paperclip}
          disabled={images.length >= MAX_IMAGES}
          onFiles={addImageFiles}
        />
        <div className="flex-1" />
        {saved && !patchTask.isPending && <span className="text-xs text-muted-foreground">Saved</span>}
        <Button size="sm" variant="outline" onClick={save} disabled={patchTask.isPending}>
          {patchTask.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Save className="h-4 w-4" aria-hidden />
          )}
          Save
        </Button>
        <Button size="sm" onClick={start} disabled={startTask.isPending} aria-label="Start task">
          {startTask.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Hammer className="h-4 w-4" aria-hidden />
          )}
          Start
        </Button>
      </div>
      <LibraryAttachments state={attachments} allowAddFolder />
    </div>
  );
}

/**
 * Detail view for a pending task (proposal or saved-for-later prompt): the
 * full task is fetched, then shown as an editable title + prompt with a
 * markdown/image attach row and the library attachments (skills, MCP
 * servers, per-folder AGENTS.md). SAVE persists edits without starting;
 * START posts them to POST /api/tasks/:id/start and the console view takes
 * over once the task flips to queued.
 */
export function ProposalDetail({ taskId }: { taskId: string }) {
  const taskQuery = useTask(taskId);

  if (taskQuery.isPending) {
    return (
      <DetailMessage>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading task…
      </DetailMessage>
    );
  }
  if (taskQuery.isError) return <DetailMessage>{taskQuery.error.message}</DetailMessage>;
  return <TaskEditorWithSkillNames key={taskQuery.data.id} task={taskQuery.data} />;
}
