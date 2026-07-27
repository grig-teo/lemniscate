import * as React from 'react';

import { useCreateService, useRepositories, useServices, useVpsTargets } from '@/lib/hooks';
import { useWorkspaceSelection } from '@/lib/selection';
import { describeApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DeployTargetFields } from '@/components/services/DeployTargetFields';
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
  const [deployTarget, setDeployTarget] = React.useState<'lemniscate' | 'vps'>('lemniscate');
  const [vpsTargetId, setVpsTargetId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const vpsTargetsQuery = useVpsTargets();

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

  const vpsTargets = vpsTargetsQuery.data ?? [];

  const submit = async () => {
    if (!repositoryId) return;
    setError(null);
    try {
      const service = await createService.mutateAsync({
        repositoryId,
        ...(name.trim() ? { name: name.trim() } : {}),
        port: Number(port) || 80,
        autoDeploy,
        ...(deployTarget === 'vps' && vpsTargetId ? { deployTarget: 'vps', vpsTargetId } : {}),
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
            <DeployTargetFields
              deployTarget={deployTarget}
              vpsTargetId={vpsTargetId}
              vpsTargets={vpsTargets}
              onTargetChange={setDeployTarget}
              onVpsChange={setVpsTargetId}
            />
            <p className="text-xs text-muted-foreground">
              {deployTarget === 'lemniscate'
                ? 'The repository needs a Dockerfile at its root. The service will live at apps.grig-teo.space/<user>/<name>.'
                : 'Deploys onto your VPS over SSH. The app is reachable at http://<vps-host>:<container-port>. Docker must be installed on the remote host.'}
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button
            onClick={() => void submit()}
            disabled={!repositoryId || createService.isPending || available.length === 0 || (deployTarget === 'vps' && !vpsTargetId)}
          >
            {createService.isPending ? 'Creating…' : 'Create service'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
