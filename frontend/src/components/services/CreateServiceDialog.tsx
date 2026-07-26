import * as React from 'react';

import { useCreateService, useRepositories, useServices } from '@/lib/hooks';
import { useWorkspaceSelection } from '@/lib/selection';
import { describeApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Create-service dialog: pick a repository that has no service yet, optional
 * name/port/autoDeploy overrides. On success the new service opens in the
 * center pane.
 */
export function CreateServiceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const repositoriesQuery = useRepositories();
  const servicesQuery = useServices();
  const createService = useCreateService();
  const { selectService } = useWorkspaceSelection();

  const [repositoryId, setRepositoryId] = React.useState('');
  const [name, setName] = React.useState('');
  const [port, setPort] = React.useState('80');
  const [autoDeploy, setAutoDeploy] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const available = React.useMemo(() => {
    const usedRepoIds = new Set((servicesQuery.data ?? []).map((svc) => svc.repositoryId));
    return (repositoriesQuery.data ?? []).filter((repo) => !usedRepoIds.has(repo.id));
  }, [repositoriesQuery.data, servicesQuery.data]);

  React.useEffect(() => {
    if (open && available.length > 0 && !repositoryId) {
      setRepositoryId(available[0]!.id);
    }
  }, [open, available, repositoryId]);

  const selectedRepo = available.find((repo) => repo.id === repositoryId);

  const submit = async () => {
    if (!repositoryId) return;
    setError(null);
    try {
      const service = await createService.mutateAsync({
        repositoryId,
        ...(name.trim() ? { name: name.trim() } : {}),
        port: Number(port) || 80,
        autoDeploy,
      });
      onOpenChange(false);
      selectService(service.id);
    } catch (err) {
      setError(describeApiError(err as Error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New service</DialogTitle>
        </DialogHeader>
        {available.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every connected repository already has a service. Connect another repository first.
          </p>
        ) : (
          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              Repository
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={repositoryId}
                onChange={(event) => setRepositoryId(event.target.value)}
              >
                {available.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Service name (URL segment)
              <Input
                value={name}
                placeholder={selectedRepo?.name ?? ''}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Container port
              <Input
                value={port}
                inputMode="numeric"
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoDeploy}
                onChange={(event) => setAutoDeploy(event.target.checked)}
              />
              Deploy automatically after each merge
            </label>
            <p className="text-xs text-muted-foreground">
              The repository needs a Dockerfile at its root. The service will live at
              apps.grig-teo.space/&lt;user&gt;/&lt;name&gt;.
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button
            onClick={() => void submit()}
            disabled={!repositoryId || createService.isPending || available.length === 0}
          >
            {createService.isPending ? 'Creating…' : 'Create service'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
