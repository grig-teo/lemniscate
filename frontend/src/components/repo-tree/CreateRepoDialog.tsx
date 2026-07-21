import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, describeApiError } from '@/lib/api';
import { useConnections, type Connection } from '@/lib/hooks';
import { providerLabel } from '@/lib/providers';
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

/**
 * Create-repo mutation kept here because lib/hooks.ts is owned elsewhere.
 * POST /api/connections/:id/repositories with { name, private }.
 */
function useCreateRepository(onCreated: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, ...body }: { connectionId: string; name: string; private: boolean }) =>
      api.post(`/api/connections/${connectionId}/repositories`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
      onCreated();
    },
  });
}

/** Form state and the submit handler for the dialog. */
function useCreateRepoForm(onOpenChange: (open: boolean) => void) {
  const [connectionId, setConnectionId] = React.useState('');
  const [name, setName] = React.useState('');
  const [isPrivate, setIsPrivate] = React.useState(true);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setName('');
      setIsPrivate(true);
      createRepo.reset();
    }
    onOpenChange(next);
  }

  const createRepo = useCreateRepository(() => handleOpenChange(false));

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!connectionId || !trimmedName) return;
    createRepo.mutate({ connectionId, name: trimmedName, private: isPrivate });
  }

  return { connectionId, setConnectionId, name, setName, isPrivate, setIsPrivate, createRepo, handleOpenChange, submit };
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

/**
 * "New repository" dialog opened from the RepoTree header + button: creates
 * a repo on a connected git host and refreshes the sidebar repository list.
 */
export function CreateRepoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const connections = useConnections();
  const form = useCreateRepoForm(onOpenChange);
  const canSubmit = Boolean(form.connectionId && form.name.trim()) && !form.createRepo.isPending;

  return (
    <Dialog open={open} onOpenChange={form.handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New repository</DialogTitle>
          <DialogDescription>
            Create a repository on one of your connected git hosts.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.submit} className="flex flex-col gap-3">
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

          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={form.isPrivate}
              onCheckedChange={form.setIsPrivate}
              aria-label="Private repository"
            />
            Private repository
          </label>

          {form.createRepo.isError && (
            <p className="text-sm text-destructive">{describeApiError(form.createRepo.error)}</p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={!canSubmit}>
              {form.createRepo.isPending ? 'Creating…' : 'Create repository'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
