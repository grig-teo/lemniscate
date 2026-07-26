/**
 * Deployment history for one service (extracted from ServiceDetail.tsx per
 * AGENTS.md section 2): status dot, commit, timestamp; expanding a row shows
 * the deploy log.
 */
import * as React from 'react';

import { useServiceDeployments } from '@/lib/hooks';
import { serviceStatusColor } from '@/lib/services';

export function DeploymentList({ serviceId }: { serviceId: string }) {
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
