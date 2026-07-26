import * as React from 'react';

import { commandTypeLabel, devicePlatformLabel, formatLastSeen, transportLabel } from '@/lib/devices';
import {
  useDeleteDevice,
  useDeviceCommands,
  useRenameDevice,
  type Device,
  type DeviceCommand,
  type DeviceEnvironment,
} from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

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

/** One run-target row: name on the left, badge(s) on the right. */
function TargetRow({ name, badges }: { name: string; badges: string[] }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="truncate">{name}</span>
      <span className="flex shrink-0 items-center gap-1">
        {badges.map((badge) => (
          <Badge key={badge} variant="secondary">
            {badge}
          </Badge>
        ))}
      </span>
    </div>
  );
}

function EnvironmentRows({ environment }: { environment: DeviceEnvironment }) {
  return (
    <>
      <MetaRow label="Docker" value={environment.dockerAvailable ? 'Running' : 'Not available'} />
      {(environment.androidDevices ?? []).map((android) => (
        <TargetRow
          key={android.serial}
          name={android.model ?? android.serial}
          badges={[transportLabel(android.transport)]}
        />
      ))}
      {(environment.iosDevices ?? []).map((ios) => (
        <TargetRow key={ios.udid} name={ios.name} badges={[ios.available ? 'available' : 'unavailable']} />
      ))}
      {(environment.simulators ?? []).map((simulator, index) => (
        <TargetRow
          key={`${simulator.name}-${index}`}
          name={simulator.name}
          badges={[simulator.runtime ?? 'simulator']}
        />
      ))}
      {(environment.emulators ?? []).map((emulator) => (
        <TargetRow key={emulator.name} name={emulator.name} badges={['emulator']} />
      ))}
    </>
  );
}

/** Live run targets reported by the agent (meta.environment capabilities). */
function AvailableTargets({ device }: { device: Device }) {
  const environment = device.meta?.environment;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm font-medium">Available targets</p>
      <div className="flex flex-col gap-1 rounded-md border p-3">
        {environment ? (
          <EnvironmentRows environment={environment} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Environment not reported yet (old agent version)
          </p>
        )}
      </div>
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


function commandRowDetail(command: DeviceCommand): string {
  if (command.type === 'run_web') {
    return `${command.payload.branch} · port ${command.payload.port}`;
  }
  if (command.type === 'build_android') return command.payload.branch ?? 'gradle build';
  if (command.type === 'run_desktop') {
    const script = (command.payload as { startScript?: string }).startScript;
    if (script) return `${command.payload.branch} · npm run ${script}`;
    return command.payload.branch ?? 'desktop app';
  }
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
      {command.status === 'done' && command.type === 'run_desktop' && (
        <span className="break-all text-xs text-muted-foreground">
          Started {(command.result as { script?: string } | null)?.script ?? 'app'} — the app
          window should open on the desktop
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
 * Details modal for one paired device: rename, presence + meta, delete, and
 * the shared command history. Run/install actions live in the console's
 * RunTaskDialog, not here.
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
            <AvailableTargets device={device} />
            <DeleteDeviceButton device={device} onDeleted={() => onOpenChange(false)} />
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
