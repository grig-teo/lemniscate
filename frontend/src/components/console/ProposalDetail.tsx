/**
 * Detail view for a pending task (proposal or saved-for-later prompt): the
 * full task is fetched, then shown as an editable title + prompt with a
 * markdown/image attach row and the library attachments (skills, MCP
 * servers, per-folder AGENTS.md). Edits are persisted via debounced autosave
 * (useAutosave); START posts them to POST /api/tasks/:id/start and the
 * console view takes over once the task flips to queued.
 *
 * Presentational pieces live in TaskEditorFields.tsx (AGENTS.md section 2).
 */
import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { api } from '@/lib/api';
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';
import {
  buildTaskEditBody,
  taskAgentsMdInitial,
  taskMcpSelections,
  taskSkillSelections,
} from '@/lib/proposal-detail';
import { useAutosave } from '@/lib/use-autosave';
import { useSkills, useImproveTask, useStartTask, useClosePrTask, useTask, type TaskImage } from '@/lib/hooks';
import { useLibraryAttachments } from '@/lib/library-attachments';
import { LibraryAttachments } from '@/components/library/LibraryAttachments';
import { EstimatedTimeBadge } from '@/components/EstimatedTimeBadge';
import { PriorityBadge } from '@/components/PriorityBadge';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { appendImageFiles, useAutoResizeTextarea } from '@/components/console/composer-utils';
import { ImageThumbnails } from '@/components/console/TaskComposerFields';
import {
  DetailMessage,
  ImproveButton,
  PromptPreview,
  useResizablePrompt,
  ViewToggle,
  type TaskWithAttachments,
} from '@/components/console/TaskEditorFields';
import { ProposalDetailActionBar } from '@/components/console/ProposalDetailActionBar';

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
  const closePrTask = useClosePrTask();
  const [title, setTitle] = React.useState(task.title);
  const [prompt, setPrompt] = React.useState(task.prompt ?? '');
  const [preview, setPreview] = React.useState(true);
  // LLM time estimate from the last Improve click; not persisted — a plain
  // prompt edit makes it stale, so it is cleared until the next Improve.
  const [estimatedTime, setEstimatedTime] = React.useState<string | null>(null);
  const [images, setImages] = React.useState<TaskImage[]>([]);
  // Follow-up task: a still-pending same-repo task to auto-start once this
  // one reaches 'done'. Prefilled from the stored task and edited via the
  // right-side FollowUpTaskSelect (AGENTS.md §6 single control).
  const [followUpTaskId, setFollowUpTaskId] = React.useState<string | null>(
    task.followUpTaskId ?? null,
  );
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
      task: { title: task.title, prompt: task.prompt ?? '', followUpTaskId: task.followUpTaskId },
      title: title.trim(),
      prompt: prompt.trim(),
      images,
      followUpTaskId,
      selections: {
        skillSlugs: attachments.skills.slugs,
        mcpServerSlugs: attachments.mcpServers.slugs,
        agentsMdFiles: attachments.agentsMd.toAssignments(),
      },
    });

  // Debounced autosave: any change to title/prompt/images/attachments triggers
  // a PATCH after 1s of inactivity.  The snapshot is JSON-compared to the
  // last-saved baseline; onSave always builds the body from the latest state.
  const autosave = useAutosave({
    value: {
      title: title.trim(),
      prompt: prompt.trim(),
      imageKeys: images.map((img) => `${img.name}#${img.dataUrl.length}`),
      skills: attachments.skills.slugs,
      mcpServerSlugs: attachments.mcpServers.slugs,
      agentsMdFiles: attachments.agentsMd.toAssignments(),
      followUpTaskId,
    },
    onSave: async () => {
      await patchTask.mutateAsync({ id: task.id, body: editBody() });
    },
  });

  const start = () => {
    autosave.cancel(); // Start sends the body itself — no duplicate PATCH.
    startTask.mutate({ id: task.id, body: editBody() });
  };
  const improve = () => {
    improveTask.mutate(
      { id: task.id, body: { title: title.trim() || undefined, prompt: prompt.trim() } },
      {
        onSuccess: (data) => {
          setPrompt(data.prompt);
          setEstimatedTime(data.estimatedTime);
        },
      },
    );
  };
  const editPrompt = (value: string) => {
    setPrompt(value);
    setEstimatedTime(null); // hand-edits invalidate the last estimate
  };
  const closePr = () => {
    if (!window.confirm('Close the pull request and delete the branch? This cannot be undone.')) {
      return;
    }
    closePrTask.mutate(task.id);
  };
  const actionError = startTask.error ?? improveTask.error ?? closePrTask.error;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-label="Task title"
        className="shrink-0 border-0 px-0 text-base font-medium shadow-none focus-visible:ring-0"
      />
      {(task.priority || task.effort || estimatedTime) && (
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
          <EstimatedTimeBadge estimatedTime={estimatedTime} />
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
            onChange={(event) => editPrompt(event.target.value)}
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
      <ProposalDetailActionBar
        task={task}
        followUpTaskId={followUpTaskId}
        onFollowUpTaskIdChange={setFollowUpTaskId}
        images={images}
        onAttachFiles={addImageFiles}
        startPending={startTask.isPending}
        onStart={start}
        closePrPending={closePrTask.isPending}
        onClosePr={closePr}
        autosaveStatus={autosave.status}
        onRetrySave={autosave.retry}
      />
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
