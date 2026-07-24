import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, describeApiError } from '@/lib/api';
import {
  buildCreateRepoBody,
  type CreateRepoBody,
  type CreateRepoInitialized,
} from '@/lib/create-repo';
import { useConnections, type Connection, type Repository } from '@/lib/hooks';
import { useAgentsMdTemplates } from '@/lib/library';
import { useLibraryAttachments } from '@/lib/library-attachments';
import { providerLabel } from '@/lib/providers';
import { useWorkspaceSelection } from '@/lib/selection';
import { LibraryAttachments } from '@/components/library/LibraryAttachments';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

/** 201 response of POST /api/connections/:id/repositories. */
interface CreateRepoResponse {
  repository: Repository;
  sync: unknown;
  initialized: CreateRepoInitialized;
  initTask?: { id: string } | null;
}

/**
 * Create-repo mutation kept here because lib/hooks.ts is owned elsewhere.
 * POST /api/connections/:id/repositories with the body from buildCreateRepoBody.
 */
function useCreateRepository(
  onCreated: (initialized: CreateRepoInitialized, initTask: { id: string } | null) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, body }: { connectionId: string; body: CreateRepoBody }) =>
      api.post<CreateRepoResponse>(`/api/connections/${connectionId}/repositories`, { ...body }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
      onCreated(data.initialized, data.initTask ?? null);
    },
  });
}

/** Form state and the submit handler for the dialog. */
function useCreateRepoForm(onOpenChange: (open: boolean) => void, connections: Connection[]) {
  const [connectionId, setConnectionId] = React.useState('');
  const [name, setName] = React.useState('');
  const [isPrivate, setIsPrivate] = React.useState(true);
  const [readme, setReadme] = React.useState(true);
  const [initialized, setInitialized] = React.useState<CreateRepoInitialized | null>(null);
  const attachments = useLibraryAttachments();
  const init = useInitProject((folders) => attachments.agentsMd.replaceFolders(folders));
  const templates = useAgentsMdTemplates();
  const selection = useWorkspaceSelection();

  // A single connection is preselected — nothing else to pick.
  React.useEffect(() => {
    if (connections.length === 1 && !connectionId) {
      setConnectionId(connections[0].id);
    }
  }, [connections, connectionId]);

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

function ConnectionSelect({
  connections,
  value,
  onChange,
}: {
  connections: Connection[];
  value: string;
  onChange: (connectionId: string) => void;
}) {
  return (
    <FormField label="Connection">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label="Connection">
          <SelectValue placeholder="Pick a connection" />
        </SelectTrigger>
        <SelectContent>
          {connections.map((connection) => (
            <SelectItem key={connection.id} value={connection.id}>
              {providerLabel(connection.provider)} @{connection.username}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

/** Post-success panel: the repo was created but initialization reported warnings. */
function InitializedWarnings({
  initialized,
  onDone,
}: {
  initialized: CreateRepoInitialized;
  onDone: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm">Repository created, with initialization warnings:</p>
      <ul className="list-disc rounded-md border border-amber-500/40 bg-amber-500/10 p-3 pl-7 text-sm">
        {initialized.warnings.map((warning) => (
          <li key={warning} className="break-words">
            {warning}
          </li>
        ))}
      </ul>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
      {label}
    </label>
  );
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const connections = useConnections();
  const form = useCreateRepoForm(onOpenChange, connections.data ?? []);
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
            ) : (
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
