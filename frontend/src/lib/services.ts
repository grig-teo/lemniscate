/**
 * Types and display helpers for Lemniscate Apps (service deployments).
 * Shapes mirror the /api/services backend contract.
 */

export type ServiceStatus = 'stopped' | 'deploying' | 'online' | 'failed';
export type DeployStatus = 'queued' | 'building' | 'starting' | 'checking' | 'online' | 'failed';

export interface ServiceDeployment {
  id: string;
  taskId: string | null;
  commitSha: string;
  status: DeployStatus;
  log: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface VpsTargetSummary {
  id: string;
  name: string;
  host: string;
  port: number;
}

export interface AppService {
  id: string;
  repositoryId: string;
  name: string;
  port: number;
  autoDeploy: boolean;
  status: ServiceStatus;
  activeContainer: string | null;
  /** Env var NAMES only — values are write-only over the API. */
  envKeys: string[];
  url: string;
  deployTarget: 'lemniscate' | 'vps';
  vpsTargetId: string | null;
  /** Present on the serialized payload when deployTarget='vps'. */
  vpsTarget?: VpsTargetSummary;
  repository: { fullName: string; connection: { username: string; provider: string } };
  deployments: ServiceDeployment[];
}

/** Dot color for the service status in lists and the detail header. */
export function serviceStatusColor(status: ServiceStatus): string {
  switch (status) {
    case 'online':
      return '#2da44e';
    case 'failed':
      return '#cf222e';
    case 'deploying':
      return '#bf8700';
    default:
      return '#6e7781';
  }
}

/** True while any deployment is mid-flight (poll for updates). */
export function hasActiveDeployment(deployments: ServiceDeployment[]): boolean {
  return deployments.some((d) => ['queued', 'building', 'starting', 'checking'].includes(d.status));
}
