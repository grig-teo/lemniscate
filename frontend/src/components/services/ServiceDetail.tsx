/**
 * Center pane for one service: URL + controls (deploy/stop/delete, live
 * logs), env-var editor (values write-only), and deployment history.
 * The env editor lives in ServiceEnvEditor.tsx and the deployment history in
 * ServiceDeployments.tsx (AGENTS.md section 2).
 */
import * as React from 'react';
import { Copy, ExternalLink, Play, Square, Trash2, X } from 'lucide-react';

import { describeApiError } from '@/lib/api';
import {
  useDeleteService,
  useDeployService,
  useServiceLogs,
  useServices,
  useStopService,
  useUpdateService,
} from '@/lib/hooks';
import { hasActiveDeployment, serviceStatusColor } from '@/lib/services';
import { useWorkspaceSelection } from '@/lib/selection';
import { DeploymentList } from '@/components/services/ServiceDeployments';
import { EnvEditor } from '@/components/services/ServiceEnvEditor';
import { Button } from '@/components/ui/button';

export function ServiceDetail({ serviceId }: { serviceId: string }) {
  const servicesQuery = useServices();
  const { selectService } = useWorkspaceSelection();
  const deployService = useDeployService();
  const stopService = useStopService();
  const deleteService = useDeleteService();
  const updateService = useUpdateService(serviceId);
  const [showLogs, setShowLogs] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const logsQuery = useServiceLogs(serviceId, showLogs);

  const service = (servicesQuery.data ?? []).find((svc) => svc.id === serviceId);
  if (!service) {
    if (servicesQuery.isLoading) return null;
    // Deleted elsewhere — close the pane.
    selectService(null);
    return null;
  }
  const deploying = hasActiveDeployment(service.deployments) || service.status === 'deploying';

  const run = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(describeApiError(err as Error));
    }
  };

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: serviceStatusColor(service.status) }}
          aria-label={service.status}
        />
        <span className="text-sm font-semibold">{service.name}</span>
        <span className="text-xs text-muted-foreground">{service.repository.fullName}</span>
        <a
          href={service.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          {service.url.replace(/^https?:\/\//, '')}
          <ExternalLink className="h-3 w-3" />
        </a>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label="Copy URL"
          onClick={() => void navigator.clipboard.writeText(service.url)}
        >
          <Copy className="h-3 w-3" />
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={deploying || deployService.isPending}
            onClick={() => void run(() => deployService.mutateAsync(service.id))}
          >
            <Play className="mr-1 h-3 w-3" />
            {deploying ? 'Deploying…' : 'Deploy'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!service.activeContainer || stopService.isPending}
            onClick={() => void run(() => stopService.mutateAsync(service.id))}
          >
            <Square className="mr-1 h-3 w-3" />
            Stop
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="mr-1 h-3 w-3" />
            Delete
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label="Close service"
            onClick={() => selectService(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 py-3">
        {actionError && <p className="text-sm text-destructive">{actionError}</p>}

        {confirmDelete && (
          <div className="flex items-center gap-2 rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
            Delete this service and stop its container?
            <Button
              size="sm"
              variant="destructive"
              onClick={() =>
                void run(async () => {
                  await deleteService.mutateAsync(service.id);
                  selectService(null);
                })
              }
            >
              Delete
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={service.autoDeploy}
            onChange={() =>
              void run(() => updateService.mutateAsync({ autoDeploy: !service.autoDeploy }))
            }
          />
          Deploy automatically after each merge
        </label>

        <EnvEditor service={service} />
        <DeploymentList serviceId={service.id} />

        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Container logs
            </span>
            <Button variant="outline" size="sm" onClick={() => setShowLogs((prev) => !prev)}>
              {showLogs ? 'Hide' : 'Show'}
            </Button>
          </div>
          {showLogs && (
            <pre className="max-h-72 overflow-auto rounded border bg-muted/50 p-2 text-xs whitespace-pre-wrap">
              {logsQuery.data ?? (logsQuery.isLoading ? 'Loading…' : 'No logs available.')}
            </pre>
          )}
        </div>
      </div>
    </section>
  );
}
