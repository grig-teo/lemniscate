/**
 * TaskComposer form state: repo choice (defaults follow the selected task),
 * prompt, images, library attachments, and the create-task submission.
 * Extracted from TaskComposer.tsx (AGENTS.md section 2); rendering lives in
 * TaskComposerFields.tsx.
 */
import * as React from 'react';

import { defaultRepositoryId } from '@/lib/default-repository';
import {
  useCreateTask,
  useLlmConfigs,
  useRepositories,
  type CreateTaskBody,
  type TaskImage,
  type TaskThinkingLevel,
} from '@/lib/hooks';
import { useLibraryAttachments } from '@/lib/library-attachments';
import { estimateTokens, resolveContextWindow } from '@/lib/prompt-composer';
import { useWorkspaceSelection } from '@/lib/selection';
import { appendImageFiles } from '@/components/console/composer-utils';

/** Composer state: repo choice (defaults follow the selected task), prompt, submit. */
export function useTaskComposer(onSubmitted?: () => void) {
  const repositoriesQuery = useRepositories();
  const llmConfigsQuery = useLlmConfigs();
  const createTask = useCreateTask();
  const { selectedTask, selectTask, selectedRepositoryId } = useWorkspaceSelection();
  const repositories = repositoriesQuery.data ?? [];
  const llmConfigs = llmConfigsQuery.data ?? [];
  const [manualRepositoryId, setManualRepositoryId] = React.useState<string | null>(null);
  const [prompt, setPrompt] = React.useState('');
  const [thinkingLevel, setThinkingLevel] = React.useState<TaskThinkingLevel | null>(null);
  const [llmConfigId, setLlmConfigId] = React.useState<string | null>(null);
  const [images, setImages] = React.useState<TaskImage[]>([]);
  const attachments = useLibraryAttachments();

  const manualChoiceValid = repositories.some((repo) => repo.id === manualRepositoryId);
  const repositoryId = manualChoiceValid
    ? (manualRepositoryId as string)
    : defaultRepositoryId(repositories, selectedTask, selectedRepositoryId);
  const repository = repositories.find((repo) => repo.id === repositoryId) ?? null;
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

  const resetDraft = () => {
    setPrompt('');
    setImages([]);
  };

  const buildBody = (later?: boolean): CreateTaskBody => {
    const agentsMdFiles = attachments.agentsMd.toAssignments();
    return {
      repositoryId,
      prompt: prompt.trim(),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(llmConfigId ? { llmConfigId } : {}),
      ...(images.length > 0 ? { images } : {}),
      // Empty selections are omitted so the task inherits the repo defaults.
      ...(attachments.skills.slugs.length > 0 ? { skills: attachments.skills.slugs } : {}),
      ...(attachments.mcpServers.slugs.length > 0
        ? { mcpServerSlugs: attachments.mcpServers.slugs }
        : {}),
      ...(agentsMdFiles.length > 0 ? { agentsMdFiles } : {}),
      ...(later ? { later: true } : {}),
    };
  };

  const selectCreatedTask = (task: {
    id: string;
    title: string;
    status: string;
    kind: string;
    repositoryId: string;
  }) => {
    selectTask({
      id: task.id,
      title: task.title,
      status: task.status,
      kind: task.kind,
      repositoryId: task.repositoryId,
    });
  };

  const submit = () => {
    if (!canSend) return;
    createTask.mutate(buildBody(), {
      onSuccess: (task) => {
        selectCreatedTask(task);
        resetDraft();
        onSubmitted?.();
      },
    });
  };

  // Save for later: park the prompt as a pending task (no enqueue, no
  // selection, no close) so it can be started from the repo tree.
  const saveLater = () => {
    if (!canSend) return;
    createTask.mutate(buildBody(true), { onSuccess: resetDraft });
  };

  return {
    repositories,
    repositoryId,
    repository,
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
    saveLater,
    attachments,
  };
}

export type TaskComposerState = ReturnType<typeof useTaskComposer>;
