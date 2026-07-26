/**
 * Device domain (agent CLI pairing + run-on-device commands): the API
 * contract types live here next to their hooks.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
// Mutations whose callers already render the error inline (dialogs, settings
// forms) opt out of the global MutationCache error toast with this meta.
import { SUPPRESS_ERROR_TOAST_META } from '@/lib/mutation-error-toast';

export type DevicePlatform = 'android' | 'ios' | 'desktop' | 'web';

export type DeviceEnvironment = {
  dockerAvailable?: boolean;
  androidDevices?: { serial: string; model?: string; transport: 'usb' | 'wifi' }[];
  iosDevices?: { name: string; udid: string; available: boolean }[];
  simulators?: { name: string; runtime?: string; state?: string; udid?: string }[];
  emulators?: { name: string }[];
};

export type DeviceMeta = {
  os?: string;
  arch?: string;
  hostname?: string;
  agentVersion?: string;
  dockerAvailable?: boolean;
  environment?: DeviceEnvironment;
};

/** GET /api/devices item — a paired device running the agent CLI. */
export type Device = {
  id: string;
  name: string;
  platform: DevicePlatform;
  meta: DeviceMeta | null;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
};

/** POST /api/devices/pairings response — 10-min TTL code for the agent CLI. */
export type DevicePairing = {
  code: string;
  expiresAt: string;
};

export type DeviceCommandStatus = 'queued' | 'sent' | 'running' | 'done' | 'failed';

export type RunWebPayload = {
  repoUrl: string;
  branch: string;
  port: number;
  composePath?: string;
};

export type InstallApkPayload = {
  apkUrl: string;
  appName?: string;
  deviceSerial?: string;
};

export type BuildAndroidPayload = {
  repoUrl: string;
  branch: string;
  gradleTask?: string;
  gradleModule?: string;
  image?: string;
  installDeviceId?: string;
  appName?: string;
};

export type RunIosPayload = {
  repoUrl: string;
  branch: string;
  scheme?: string;
  destination?: string;
};

/** GET /api/devices/:id/commands item. */
export type DeviceCommand = {
  id: string;
  type: 'run_web' | 'install_apk' | 'build_android' | (string & {});
  payload: Partial<RunWebPayload> & Partial<InstallApkPayload> & Partial<BuildAndroidPayload>;
  status: DeviceCommandStatus;
  result: {
    url?: string;
    port?: number;
    projectDir?: string;
    savedTo?: string;
    installIntentLaunched?: boolean;
    artifactKey?: string;
    apkName?: string;
    sizeBytes?: number;
    error?: string;
    log?: string;
    logArtifactUrl?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

/** Any payload shape accepted by POST /api/devices/:id/commands. */
export type DeviceCommandPayload = Partial<RunWebPayload> &
  Partial<InstallApkPayload> &
  Partial<BuildAndroidPayload> &
  Partial<RunIosPayload>;

/** GET /api/tasks/:id/run-targets device item. */
export type TaskRunTargetDevice = {
  id: string;
  name: string;
  platform: string;
  online: boolean;
  meta: DeviceMeta | null;
};

/** GET /api/tasks/:id/run-targets item — one affected target plus its paired devices. */
export type TaskRunTarget = {
  target: 'android' | 'ios' | 'web' | 'desktop';
  commandType: 'build_android' | 'run_ios' | 'run_web' | 'run_desktop';
  devices: TaskRunTargetDevice[];
};

/** Paired devices; polls every 15s by default so presence stays fresh. */
export function useDevices(options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<{ devices: Device[] }>('/api/devices').then((res) => res.devices),
    refetchInterval: options?.refetchInterval ?? 15_000,
  });
}

/** POST /api/devices/pairings — creating a new code invalidates the prior one. */
export function useCreatePairing() {
  return useMutation({
    mutationFn: () => api.post<DevicePairing>('/api/devices/pairings'),
    meta: SUPPRESS_ERROR_TOAST_META, // PairingDialog renders isError inline
  });
}

/** PATCH /api/devices/:id — rename a device. */
export function useRenameDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<{ device: Device }>(`/api/devices/${id}`, { name }).then((res) => res.device),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/** DELETE /api/devices/:id — unpair and remove a device. */
export function useDeleteDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/devices/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

/** Recent commands for one device; polls while the details modal is open. */
export function useDeviceCommands(
  deviceId: string | null,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ['device-commands', deviceId],
    queryFn: () =>
      api
        .get<{ commands: DeviceCommand[] }>(`/api/devices/${deviceId}/commands`)
        .then((res) => res.commands),
    enabled: deviceId !== null,
    refetchInterval: options?.refetchInterval ?? 5_000,
  });
}

/** POST /api/devices/:id/commands — queue any agent command, optionally linked to a task. */
export function useCreateDeviceCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      deviceId,
      type,
      payload,
      taskId,
    }: {
      deviceId: string;
      type: DeviceCommand['type'];
      payload: DeviceCommandPayload;
      taskId?: string;
    }) =>
      api
        .post<{ command: DeviceCommand }>(`/api/devices/${deviceId}/commands`, {
          type,
          payload,
          ...(taskId ? { taskId } : {}),
        })
        .then((res) => res.command),
    onSuccess: (_command, { deviceId }) => {
      void queryClient.invalidateQueries({ queryKey: ['device-commands', deviceId] });
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    meta: SUPPRESS_ERROR_TOAST_META, // RunTaskDialog renders isError inline
  });
}
