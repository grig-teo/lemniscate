/**
 * Detail view for a pending task (proposal or saved-for-later prompt): the
 * full task is fetched, then shown as an editable title + prompt with a
 * markdown/image attach row and the library attachments (skills, MCP
 * servers, per-folder AGENTS.md). SAVE persists edits without starting;
 * START posts them to POST /api/tasks/:id/start and the console view takes
 * over once the task flips to queued.
 *
 * Presentational pieces live in TaskEditorFields.tsx (AGENTS.md section 2).
 */
import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Hammer, Loader2, Paperclip, Save } from 'lucide-react';

import { api } from '@/lib/api';
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';
import {
  buildTaskEditBody,
  taskAgentsMdInitial,
  taskMcpSelections,
  taskSkillSelections,
} from '@/lib/proposal-detail';
import { useSkills, useImproveTask, useStartTask, useTask, type TaskImage } from '@/lib/hooks';
import { useLibraryAttachments } from '@/lib/library-attachments';
import { IMAGE_ACCEPT, MAX_IMAGES } from '@/lib/prompt-composer';
import { LibraryAttachments } from '@/components/library/LibraryAttachments';
import { PriorityBadge } from '@/components/PriorityBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { appendImageFiles, useAutoResizeTextarea } from '@/components/console/composer-utils';
import { ImageThumbnails } from '@/components/console/TaskComposerFields';
import {
  AttachFileButton,
  DetailMessage,
  ImproveButton,
  PromptPreview,
  useResizablePrompt,
  ViewToggle,
  type TaskWithAttachments,
} from '@/components/console/TaskEditorFields';

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
    meta: SUPPRESS_ERROR_TOAST_META, // this pane renders the error inline
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
  const improveTask = useImproveTask();
  const [title, setTitle] = React.useState(task.title);
  const [prompt, setPrompt] = React.useState(task.prompt ?? '');
  const [preview, setPreview] = React.useState(true);
  const [images, setImages] = React.useState<TaskImage[]>([]);
  const [saved, setSaved] = React.useState(false);
  const textareaRef = useAutoResizeTextarea(prompt, 14);
  const promptResize = useResizablePrompt();
  const attachments = useLibraryAttachments({
    skills: initialSkills,
    mcpServers: taskMcpSelections(task.mcpServers),
    agentsMd: taskAgentsMdInitial(task.agentsMdFiles),
  });

  const addImageFiles = (files: FileList | null) => appendImageFiles(files, setImages);
  const removeImage = (index: number) =>
    setImages((prev) => prev.filter((_, i) => i !== index));

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
  const improve = () => {
    improveTask.mutate(
      { id: task.id, body: { title: title.trim() || undefined, prompt: prompt.trim() } },
      { onSuccess: (data) => setPrompt(data.prompt) },
    );
  };
  const actionError = startTask.error ?? patchTask.error ?? improveTask.error;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-label="Task title"
        className="shrink-0 border-0 px-0 text-base font-medium shadow-none focus-visible:ring-0"
      />
      {(task.priority || task.effort) && (
        <div className="flex shrink-0 items-center gap-1.5">
          <PriorityBadge priority={task.priority} className="px-1.5 py-0 text-[10px]" />
          {task.effort && (
            <Badge
              variant="outline"
              className="shrink-0 px-1.5 py-0 text-[10px] text-muted-foreground"
            >
              {task.effort} effort
            </Badge>
          )}
        </div>
      )}
      {actionError && <p className="shrink-0 text-xs text-destructive">{actionError.message}</p>}
      <div
        ref={promptResize.boxRef}
        style={promptResize.height !== null ? { height: promptResize.height } : undefined}
        className="flex h-1/2 shrink-0 flex-col overflow-hidden rounded-lg border bg-background shadow-sm focus-within:ring-1 focus-within:ring-ring"
      >
        <ImageThumbnails images={images} onRemove={removeImage} />
        <ViewToggle
          preview={preview}
          onChange={setPreview}
          action={
            <ImproveButton
              pending={improveTask.isPending}
              disabled={!prompt.trim()}
              onClick={improve}
            />
          }
        />
        {preview ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            <PromptPreview prompt={prompt} />
          </div>
        ) : (
          <Textarea
            ref={textareaRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Prompt…"
            aria-label="Task prompt"
            className="min-h-0 flex-1 resize-none overflow-y-auto border-0 shadow-none focus-visible:ring-0"
          />
        )}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize prompt field"
        title="Drag to resize"
        onMouseDown={promptResize.startDrag}
        className="flex h-2 shrink-0 cursor-row-resize items-center justify-center"
      >
        <div className="h-0.5 w-10 rounded-full bg-border" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <LibraryAttachments state={attachments} columns repositoryId={task.repositoryId} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex-1" />
        <AttachFileButton
          accept={IMAGE_ACCEPT}
          label="Attach file"
          icon={Paperclip}
          disabled={images.length >= MAX_IMAGES}
          onFiles={addImageFiles}
        />
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
    </div>
  );
}

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
