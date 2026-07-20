import * as React from 'react';
import { Loader2, Send } from 'lucide-react';

import { defaultRepositoryId } from '@/lib/default-repository';
import { useCreateTask, useRepositories, type Repository } from '@/lib/hooks';
import { ProviderIcon } from '@/lib/providers';
import { useWorkspaceSelection } from '@/lib/selection';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/** Composer state: repo choice (defaults follow the selected task), prompt, submit. */
function useTaskComposer() {
  const repositoriesQuery = useRepositories();
  const createTask = useCreateTask();
  const { selectedTask, selectTask } = useWorkspaceSelection();
  const repositories = repositoriesQuery.data ?? [];
  const [manualRepositoryId, setManualRepositoryId] = React.useState<string | null>(null);
  const [prompt, setPrompt] = React.useState('');

  const manualChoiceValid = repositories.some((repo) => repo.id === manualRepositoryId);
  const repositoryId = manualChoiceValid
    ? (manualRepositoryId as string)
    : defaultRepositoryId(repositories, selectedTask);

  const canSend =
    repositories.length > 0 &&
    Boolean(repositoryId) &&
    prompt.trim().length > 0 &&
    !createTask.isPending;

  const submit = () => {
    if (!canSend) return;
    createTask.mutate(
      { repositoryId, prompt: prompt.trim() },
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
        },
      },
    );
  };

  return { repositories, repositoryId, setManualRepositoryId, prompt, setPrompt, canSend, createTask, submit };
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
      <SelectTrigger className="w-56 shrink-0" aria-label="Repository">
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

/**
 * Bottom bar of the agent console — chat-style composer that starts a new
 * prompt task on a chosen repository and selects it. Submits on
 * Cmd/Ctrl+Enter or the send button; disabled while a task is being created
 * or when no repositories are connected.
 */
export function TaskComposer() {
  const composer = useTaskComposer();

  return (
    <div className="border-t px-3 py-2">
      {composer.createTask.isError && (
        <p className="pb-2 text-xs text-destructive">{composer.createTask.error.message}</p>
      )}
      <div className="flex items-end gap-2">
        <ComposerRepoSelect
          repositories={composer.repositories}
          repositoryId={composer.repositoryId}
          onChange={composer.setManualRepositoryId}
        />
        <Textarea
          value={composer.prompt}
          onChange={(event) => composer.setPrompt(event.target.value)}
          onKeyDown={(event) => submitOnCmdEnter(event, composer.submit)}
          placeholder="Describe a task for the agent… (⌘/Ctrl+Enter to send)"
          rows={2}
          aria-label="Prompt"
          className="min-h-9 flex-1 resize-none"
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
