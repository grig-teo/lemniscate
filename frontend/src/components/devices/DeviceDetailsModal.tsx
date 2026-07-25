import * as React from 'react';

import { describeApiError } from '@/lib/api';
import { defaultRunPort, devicePlatformLabel, formatLastSeen, runWebBlocker } from '@/lib/devices';
import {
  useDeleteDevice,
  useDeviceCommands,
  useRenameDevice,
  useRepositories,
  useRunOnDevice,
  type Device,
  type DeviceCommand,
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
                    {r.fullName}
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

function CommandRow({ command }: { command: DeviceCommand }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border p-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs">{command.payload.repoUrl}</span>
        <StatusBadge status={command.status} />
      </div>
      <span className="text-xs text-muted-foreground">
        {command.payload.branch} · port {command.payload.port}
      </span>
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
 * run-on-device form (desktop + docker only) and its command history.
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
