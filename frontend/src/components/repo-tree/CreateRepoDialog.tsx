import * as React from 'react';

import { describeApiError } from '@/lib/api';
import { buildCreateRepoBody, type CreateRepoInitialized } from '@/lib/create-repo';
import { useConnections, useCreateRepository, type Connection } from '@/lib/hooks';
import { useAgentsMdTemplates } from '@/lib/library';
import { useLibraryAttachments } from '@/lib/library-attachments';
import { useWorkspaceSelection } from '@/lib/selection';
import { LibraryAttachments } from '@/components/library/LibraryAttachments';
import {
  ConnectionSelect,
  InitializedWarnings,
  ToggleRow,
} from '@/components/repo-tree/CreateRepoFields';
import {
  InitPromptSection,
  useInitProject,
} from '@/components/repo-tree/CreateRepoSections';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';

/** Form state and the submit handler for the dialog. */
function useCreateRepoForm(
  onOpenChange: (open: boolean) => void,
  connections: Connection[],
  presetConnectionId?: string,
) {
  const [connectionId, setConnectionId] = React.useState(presetConnectionId ?? '');
  const [name, setName] = React.useState('');
  const [isPrivate, setIsPrivate] = React.useState(true);
  const [readme, setReadme] = React.useState(true);
  const [initialized, setInitialized] = React.useState<CreateRepoInitialized | null>(null);
  const attachments = useLibraryAttachments();
  const init = useInitProject((folders) => attachments.agentsMd.replaceFolders(folders));
  const templates = useAgentsMdTemplates();
  const selection = useWorkspaceSelection();

  // A single connection, or a preset, is preselected — nothing else to pick.
  React.useEffect(() => {
    if (presetConnectionId) {
      setConnectionId(presetConnectionId);
      return;
    }
    if (connections.length === 1 && !connectionId) {
      setConnectionId(connections[0].id);
    }
  }, [connections, connectionId, presetConnectionId]);

  const defaultTemplateId = React.useMemo(() => {
    const all = templates.data ?? [];
    return (all.find((t) => t.slug === 'default-lemniscate-agents-md') ?? all[0])?.id ?? null;
  }, [templates.data]);

  function reset() {
    setConnectionId('');
    setName('');
    setIsPrivate(true);
    setReadme(true);
    setInitialized(null);
    attachments.reset();
    init.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      reset();
      createRepo.reset();
    }
    onOpenChange(next);
  }

  const createRepo = useCreateRepository((info, initTask) => {
    if (initTask) {
      selection.selectTask({
        id: initTask.id,
        title: init.prompt.trim().slice(0, 80) || 'Init project',
        status: 'queued',
        kind: 'prompt',
      });
    }
    if (info.warnings.length === 0) {
      handleOpenChange(false);
      return;
    }
    setInitialized(info);
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!connectionId || !name.trim()) return;
    const body = buildCreateRepoBody({
      name,
      isPrivate,
      readme,
      skillSlugs: attachments.skills.slugs,
      mcpServerSlugs: attachments.mcpServers.slugs,
      initPrompt: init.prompt,
      agentsMdFiles: attachments.agentsMd.toAssignments(defaultTemplateId),
    });
    createRepo.mutate({ connectionId, body });
  }

  return {
    connectionId,
    setConnectionId,
    name,
    setName,
    isPrivate,
    setIsPrivate,
    readme,
    setReadme,
    attachments,
    init,
    initialized,
    createRepo,
    handleOpenChange,
    submit,
  };
}

/**
 * "New repository" dialog opened from the RepoTree header + button: creates
 * a repo on a connected git host — seeded with a README, per-folder
 * AGENTS.md files, selected skills (.agents/skills/) and MCP servers
 * (.mcp.json) — and starts the optional first init-prompt task on it.
 */
export function CreateRepoDialog({
  open,
  onOpenChange,
  presetConnectionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lock the dialog to this connection (e.g. the gitlem connection from the grid). */
  presetConnectionId?: string;
}) {
  const connections = useConnections();
  const form = useCreateRepoForm(onOpenChange, connections.data ?? [], presetConnectionId);
  const canSubmit = Boolean(form.connectionId && form.name.trim()) && !form.createRepo.isPending;

  return (
    <Dialog open={open} onOpenChange={form.handleOpenChange}>
      <DialogContent className="max-h-[85vh] w-full max-w-xl overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>New repository</DialogTitle>
          <DialogDescription>
            Create a repository on one of your connected git hosts.
          </DialogDescription>
        </DialogHeader>

        {form.initialized ? (
          <InitializedWarnings
            initialized={form.initialized}
            onDone={() => form.handleOpenChange(false)}
          />
        ) : (
          <form onSubmit={form.submit} className="flex min-w-0 flex-col gap-3">
            {connections.data?.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect a git host in settings first.
              </p>
            ) : presetConnectionId ? null : (
              <ConnectionSelect
                connections={connections.data ?? []}
                value={form.connectionId}
                onChange={form.setConnectionId}
              />
            )}

            <FormField label="Repository name">
              <Input
                value={form.name}
                onChange={(event) => form.setName(event.target.value)}
                placeholder="my-project"
                autoComplete="off"
                required
              />
            </FormField>

            <ToggleRow
              label="Private repository"
              checked={form.isPrivate}
              onCheckedChange={form.setIsPrivate}
            />

            <InitPromptSection init={form.init} />

            <LibraryAttachments state={form.attachments} />

            <ToggleRow
              label="Create README.md"
              checked={form.readme}
              onCheckedChange={form.setReadme}
            />

            {form.createRepo.isError && (
              <p className="break-words text-sm text-destructive">
                {describeApiError(form.createRepo.error)}
              </p>
            )}

            <DialogFooter>
              <Button type="submit" disabled={!canSubmit}>
                {form.createRepo.isPending ? 'Creating…' : 'Create repository'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
