import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { useCreateTask, type Repository } from '@/lib/hooks';
import { useWorkspaceSelection } from '@/lib/selection';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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

/** Form state + submit for the "New prompt" dialog. */
function useNewPromptForm(
  repositories: Repository[],
  open: boolean,
  onOpenChange: (open: boolean) => void,
) {
  const createTask = useCreateTask();
  const { selectTask } = useWorkspaceSelection();
  const [repositoryId, setRepositoryId] = React.useState('');
  const [prompt, setPrompt] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setRepositoryId((prev) => prev || repositories[0]?.id || '');
    setPrompt('');
    createTask.reset();
  }, [open]);

  const submit = () => {
    if (!repositoryId || !prompt.trim()) return;
    createTask.mutate(
      { repositoryId, prompt: prompt.trim() },
      {
        onSuccess: (task) => {
          selectTask({ id: task.id, title: task.title, status: task.status, kind: task.kind });
          onOpenChange(false);
        },
      },
    );
  };

  return { createTask, repositoryId, setRepositoryId, prompt, setPrompt, submit };
}

function PromptFormFields({
  repositories,
  form,
}: {
  repositories: Repository[];
  form: ReturnType<typeof useNewPromptForm>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Select value={form.repositoryId} onValueChange={form.setRepositoryId}>
        <SelectTrigger aria-label="Repository">
          <SelectValue placeholder="Select a repository…" />
        </SelectTrigger>
        <SelectContent>
          {repositories.map((repo) => (
            <SelectItem key={repo.id} value={repo.id}>
              {repo.fullName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Textarea
        value={form.prompt}
        onChange={(event) => form.setPrompt(event.target.value)}
        placeholder="Describe the improvement you want the agent to make…"
        rows={5}
        aria-label="Prompt"
      />

      {form.createTask.isError && (
        <p className="text-sm text-destructive">{form.createTask.error.message}</p>
      )}
    </div>
  );
}

/** Dialog creating a prompt task on a chosen repository. */
export function NewPromptDialog({
  open,
  onOpenChange,
  repositories,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositories: Repository[];
}) {
  const form = useNewPromptForm(repositories, open, onOpenChange);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New prompt</DialogTitle>
          <DialogDescription>
            Ask the agent to propose a code improvement on a repository.
          </DialogDescription>
        </DialogHeader>

        <PromptFormFields repositories={repositories} form={form} />

        <DialogFooter>
          <Button
            onClick={form.submit}
            disabled={!form.repositoryId || !form.prompt.trim() || form.createTask.isPending}
          >
            {form.createTask.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Start task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
