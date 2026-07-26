import * as React from 'react';
import { Copy, ExternalLink, Play, Square, Trash2, X } from 'lucide-react';

import { describeApiError } from '@/lib/api';
import {
  useDeleteService,
  useDeployService,
  useSaveServiceEnv,
  useServiceDeployments,
  useServiceLogs,
  useServices,
  useStopService,
  useUpdateService,
} from '@/lib/hooks';
import { hasActiveDeployment, serviceStatusColor, type AppService } from '@/lib/services';
import { useWorkspaceSelection } from '@/lib/selection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

function EnvEditor({ service }: { service: AppService }) {
  const saveEnv = useSaveServiceEnv(service.id);
  const [removed, setRemoved] = React.useState<string[]>([]);
  const [added, setAdded] = React.useState<{ key: string; value: string }[]>([]);
  const [newKey, setNewKey] = React.useState('');
  const [newValue, setNewValue] = React.useState('');
  const [message, setMessage] = React.useState<string | null>(null);

  const visibleKeys = service.envKeys.filter((key) => !removed.includes(key));
  const dirty = removed.length > 0 || added.length > 0;

  const save = async () => {
    setMessage(null);
    try {
      await saveEnv.mutateAsync({
        set: Object.fromEntries(added.map((entry) => [entry.key, entry.value])),
        remove: removed,
      });
      setRemoved([]);
      setAdded([]);
      setMessage('Saved — applies from the next deploy.');
    } catch (err) {
      setMessage(describeApiError(err as Error));
    }
  };

  return (
    <div className="grid gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Environment variables
      </span>
      {visibleKeys.length === 0 && added.length === 0 && (
        <p className="text-xs text-muted-foreground/70">No env vars set.</p>
      )}
      {visibleKeys.map((key) => (
        <div key={key} className="flex items-center gap-2 text-sm">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{key}</code>
          <span className="text-xs text-muted-foreground">•••</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-6 w-6"
            aria-label={`Remove ${key}`}
            onClick={() => setRemoved((prev) => [...prev, key])}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
      {added.map((entry) => (
        <div key={entry.key} className="flex items-center gap-2 text-sm">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{entry.key}</code>
          <span className="text-xs text-muted-foreground">(new)</span>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          className="h-8 w-40"
          placeholder="KEY"
          value={newKey}
          onChange={(event) => setNewKey(event.target.value)}
        />
        <Input
          className="h-8 flex-1"
          placeholder="value"
          type="password"
          value={newValue}
          onChange={(event) => setNewValue(event.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newKey)}
          onClick={() => {
            setAdded((prev) => [...prev.filter((e) => e.key !== newKey), { key: newKey, value: newValue }]);
            setNewKey('');
            setNewValue('');
          }}
        >
          Add
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!dirty || saveEnv.isPending} onClick={() => void save()}>
          {saveEnv.isPending ? 'Saving…' : 'Save env'}
        </Button>
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
      </div>
    </div>
  );
}

function DeploymentList({ serviceId }: { serviceId: string }) {
  const deploymentsQuery = useServiceDeployments(serviceId);
  const [openLogId, setOpenLogId] = React.useState<string | null>(null);
  const deployments = deploymentsQuery.data ?? [];
  return (
    <div className="grid gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Deployments
      </span>
      {deployments.length === 0 && (
        <p className="text-xs text-muted-foreground/70">No deployments yet.</p>
      )}
      {deployments.map((dep) => (
        <div key={dep.id} className="rounded border">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => setOpenLogId(openLogId === dep.id ? null : dep.id)}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{
                backgroundColor: serviceStatusColor(
                  dep.status === 'online' ? 'online' : dep.status === 'failed' ? 'failed' : 'deploying',
                ),
              }}
            />
            <span className="font-medium">{dep.status}</span>
            <code className="text-xs text-muted-foreground">{dep.commitSha.slice(0, 8)}</code>
            <span className="ml-auto text-xs text-muted-foreground">
              {new Date(dep.createdAt).toLocaleString()}
            </span>
          </button>
          {openLogId === dep.id && dep.log && (
            <pre className="max-h-64 overflow-auto border-t bg-muted/50 p-2 text-xs whitespace-pre-wrap">
              {dep.log}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Center pane for one service: URL + controls (deploy/stop/delete, live
 * logs), env-var editor (values write-only), and deployment history.
 */
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
