import * as React from 'react';

import { describeApiError } from '@/lib/api';
import {
  androidRepos,
  builderDevices,
  canInstallApk,
  commandTypeLabel,
  defaultRunPort,
  devicePlatformLabel,
  formatLastSeen,
  repoPlatformLabel,
  runWebBlocker,
} from '@/lib/devices';
import {
  useDeleteDevice,
  useDeployAndroid,
  useDeviceCommands,
  useDevices,
  useInstallApk,
  useRenameDevice,
  useRepositories,
  useRunOnDevice,
  type Device,
  type DeviceCommand,
  type Repository,
} from '@/lib/hooks';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

/** Inline-editable device name — saves on blur/Enter via PATCH /api/devices/:id. */
function DeviceName({ device }: { device: Device }) {
  const rename = useRenameDevice();
  const [name, setName] = React.useState(device.name);
  React.useEffect(() => setName(device.name), [device.name]);

  function save() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== device.name) {
      rename.mutate({ id: device.id, name: trimmed });
    }
  }

  return (
    <Input
      value={name}
      onChange={(event) => setName(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      aria-label="Device name"
    />
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}

function DeviceMeta({ device }: { device: Device }) {
  const meta = device.meta;
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3">
      <MetaRow label="Platform" value={devicePlatformLabel(device.platform)} />
      <MetaRow label="OS" value={meta?.os ?? '—'} />
      <MetaRow label="Arch" value={meta?.arch ?? '—'} />
      <MetaRow label="Hostname" value={meta?.hostname ?? '—'} />
      <MetaRow label="Agent version" value={meta?.agentVersion ?? '—'} />
      <MetaRow label="Docker" value={meta?.dockerAvailable ? 'yes' : 'no'} />
    </div>
  );
}

function DeleteDeviceButton({ device, onDeleted }: { device: Device; onDeleted: () => void }) {
  const del = useDeleteDevice();
  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      disabled={del.isPending}
      onClick={() => {
        if (window.confirm(`Remove device "${device.name}"? It will be unpaired.`)) {
          del.mutate(device.id, { onSuccess: onDeleted });
        }
      }}
    >
      {del.isPending ? 'Removing…' : 'Delete device'}
    </Button>
  );
}

/** Repo fullName with a small platform badge when detection ran. */
function RepoSelectLabel({ repo }: { repo: Repository }) {
  const label = repoPlatformLabel(repo.platform);
  return (
    <span className="flex items-center gap-2">
      {repo.fullName}
      {label && (
        <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
          {label}
        </span>
      )}
    </span>
  );
}

/** "Run a repository on this device" form → POST run_web command. */
function RunOnDeviceSection({ device }: { device: Device }) {
  const repos = useRepositories();
  const run = useRunOnDevice();
  const blocker = runWebBlocker(device);
  const [repoId, setRepoId] = React.useState('');
  const [branch, setBranch] = React.useState('');
  const [port, setPort] = React.useState(String(defaultRunPort()));

  const repo = (repos.data ?? []).find((r) => r.id === repoId) ?? null;
  const portNumber = Number.parseInt(port, 10);
  const portValid = Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65_535;
  const canSubmit =
    blocker === null && repo !== null && branch.trim() !== '' && portValid && !run.isPending;

  function selectRepo(id: string) {
    setRepoId(id);
    const next = repos.data?.find((r) => r.id === id);
    if (next) setBranch(next.defaultBranch);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!repo || !canSubmit) return;
    run.mutate({
      deviceId: device.id,
      payload: { repoUrl: repo.cloneUrl, branch: branch.trim(), port: portNumber },
    });
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3">
      <p className="text-sm font-medium">Run a repository on this device</p>
      {blocker ? (
        <p className="text-sm text-muted-foreground">{blocker}</p>
      ) : (
        <>
          <FormField label="Repository">
            <Select value={repoId} onValueChange={selectRepo}>
              <SelectTrigger aria-label="Repository">
                <SelectValue placeholder="Pick a repository" />
              </SelectTrigger>
              <SelectContent>
                {(repos.data ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    <RepoSelectLabel repo={r} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <div className="flex gap-2">
            <FormField label="Branch">
              <Input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
                autoComplete="off"
              />
            </FormField>
            <FormField label="Port">
              <Input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
            </FormField>
          </div>

          {run.isError && (
            <p className="break-words text-sm text-destructive">
              {describeApiError(run.error)}
            </p>
          )}
          {run.isSuccess && !run.isPending && (
            <p className="text-sm text-muted-foreground">Command sent — see history below.</p>
          )}

          <Button type="submit" disabled={!canSubmit}>
            {run.isPending ? 'Sending…' : 'Run on this device'}
          </Button>
        </>
      )}
    </form>
  );
}

/** "Build & install from repository" form → POST deploy-android (build→install chain). */
function BuildInstallSection({ device }: { device: Device }) {
  const repos = useRepositories();
  const devices = useDevices();
  const deploy = useDeployAndroid();
  const [repoId, setRepoId] = React.useState('');
  const [builderId, setBuilderId] = React.useState('');

  const candidates = androidRepos(repos.data ?? []);
  const builders = builderDevices(devices.data ?? []);
  const canSubmit = repoId !== '' && builderId !== '' && !deploy.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    deploy.mutate({ repositoryId: repoId, buildDeviceId: builderId, installDeviceId: device.id });
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3">
      <p className="text-sm font-medium">Build &amp; install from repository</p>
      <FormField label="Repository">
        <Select value={repoId} onValueChange={setRepoId}>
          <SelectTrigger aria-label="Repository to build">
            <SelectValue placeholder="Pick an android repository" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                <RepoSelectLabel repo={r} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField label="Builder device">
        <Select value={builderId} onValueChange={setBuilderId}>
          <SelectTrigger aria-label="Builder device">
            <SelectValue placeholder="Pick a builder (desktop + docker)" />
          </SelectTrigger>
          <SelectContent>
            {builders.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      {candidates.length === 0 && (
        <p className="text-sm text-muted-foreground">No android-platform repositories yet.</p>
      )}
      {builders.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No online builder devices (desktop with docker) available.
        </p>
      )}
      {deploy.isError && (
        <p className="break-words text-sm text-destructive">{describeApiError(deploy.error)}</p>
      )}
      {deploy.isSuccess && !deploy.isPending && (
        <p className="text-sm text-muted-foreground">Build queued — see history below.</p>
      )}
      <Button type="submit" disabled={!canSubmit}>
        {deploy.isPending ? 'Sending…' : 'Build & Install'}
      </Button>
    </form>
  );
}

/** "Install an APK on this device" form → POST install_apk command. */
function InstallApkSection({ device }: { device: Device }) {
  const install = useInstallApk();
  const [apkUrl, setApkUrl] = React.useState('');
  const [appName, setAppName] = React.useState('');

  const urlValid = /^https?:\/\/.+/.test(apkUrl.trim());
  const canSubmit = urlValid && !install.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    install.mutate({
      deviceId: device.id,
      payload: { apkUrl: apkUrl.trim(), appName: appName.trim() || undefined },
    });
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3">
      <p className="text-sm font-medium">Install an APK on this device</p>
      <FormField label="APK URL">
        <Input
          value={apkUrl}
          onChange={(event) => setApkUrl(event.target.value)}
          placeholder="https://…/app-release.apk"
          autoComplete="off"
        />
      </FormField>
      <FormField label="App name (optional)">
        <Input
          value={appName}
          onChange={(event) => setAppName(event.target.value)}
          placeholder="My App"
          autoComplete="off"
        />
      </FormField>

      {install.isError && (
        <p className="break-words text-sm text-destructive">{describeApiError(install.error)}</p>
      )}
      {install.isSuccess && !install.isPending && (
        <p className="text-sm text-muted-foreground">Command sent — see history below.</p>
      )}

      <Button type="submit" disabled={!canSubmit}>
        {install.isPending ? 'Sending…' : 'Install APK'}
      </Button>
    </form>
  );
}

function commandRowDetail(command: DeviceCommand): string {
  if (command.type === 'run_web') {
    return `${command.payload.branch} · port ${command.payload.port}`;
  }
  if (command.type === 'build_android') return command.payload.branch ?? 'gradle build';
  return command.payload.appName ?? 'APK package';
}

function CommandRow({ command }: { command: DeviceCommand }) {
  const title = command.payload.repoUrl ?? command.payload.apkUrl ?? '';
  const detail = commandRowDetail(command);
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border p-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs">{title}</span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">{commandTypeLabel(command.type)}</span>
          <StatusBadge status={command.status} />
        </span>
      </div>
      <span className="text-xs text-muted-foreground">{detail}</span>
      {command.status === 'done' && command.result?.url && (
        <a
          href={command.result.url}
          target="_blank"
          rel="noreferrer"
          className="break-all text-xs text-blue-500 underline"
        >
          {command.result.url}
        </a>
      )}
      {command.status === 'done' && command.result?.savedTo && (
        <span className="break-all text-xs text-muted-foreground">
          Saved to {command.result.savedTo}
          {command.result.installIntentLaunched ? ' · install intent launched' : ''}
        </span>
      )}
      {command.status === 'done' && command.result?.artifactKey && (
        <span className="break-all text-xs text-muted-foreground">
          Built {command.result.apkName ?? 'APK'}
          {command.result.sizeBytes ? ` · ${(command.result.sizeBytes / 1_000_000).toFixed(1)} MB` : ''}
          {' · install queued'}
        </span>
      )}
      {command.status === 'failed' && command.result?.error && (
        <p className="break-words text-xs text-destructive">{command.result.error}</p>
      )}
    </li>
  );
}

/** Recent run commands for the device; polls every 5s while the modal is open. */
function CommandHistory({ deviceId }: { deviceId: string }) {
  const commands = useDeviceCommands(deviceId);
  if (!commands.data || commands.data.length === 0) {
    return <p className="text-sm text-muted-foreground">No commands yet.</p>;
  }
  return (
    <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto">
      {commands.data.map((command) => (
        <CommandRow key={command.id} command={command} />
      ))}
    </ul>
  );
}

/**
 * Details modal for one paired device: rename, presence + meta, delete, the
 * run-on-device form (desktop + docker only), the APK install form
 * (android/desktop) and the shared command history.
 */
export function DeviceDetailsModal({
  device,
  open,
  onOpenChange,
}: {
  device: Device | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-full max-w-lg overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>Device details</DialogTitle>
          <DialogDescription>
            {device
              ? `${device.online ? 'Online' : 'Offline'} · last seen ${formatLastSeen(device.lastSeenAt, new Date())}`
              : 'Device not found'}
          </DialogDescription>
        </DialogHeader>

        {device && (
          <div className="flex min-w-0 flex-col gap-4">
            <DeviceName device={device} />
            <DeviceMeta device={device} />
            <DeleteDeviceButton device={device} onDeleted={() => onOpenChange(false)} />
            <RunOnDeviceSection device={device} />
            {device.platform === 'android' && device.online && (
              <BuildInstallSection device={device} />
            )}
            {canInstallApk(device) && <InstallApkSection device={device} />}
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-sm font-medium">Command history</p>
              <CommandHistory deviceId={device.id} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
