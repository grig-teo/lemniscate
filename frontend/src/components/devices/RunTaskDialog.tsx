import * as React from 'react';
import { Loader2, Play } from 'lucide-react';

import { describeApiError } from '@/lib/api';
import {
  androidTargetOptions,
  dockerHint,
  iosTargetOptions,
  transportLabel,
} from '@/lib/devices';
import {
  useCreateDeviceCommand,
  useDeviceCommands,
  useRepositories,
  useTaskRunTargets,
  type DeviceCommand,
  type Repository,
  type TaskRunTarget,
} from '@/lib/hooks';
import type { SelectedTask } from '@/lib/selection';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const RUN_TARGET_LABELS: Record<TaskRunTarget['target'], string> = {
  android: 'Android app',
  ios: 'iOS app',
  web: 'Web (Docker)',
  desktop: 'Desktop app',
};

/** Reference to a command dispatched from this dialog (for live status polling). */
type DispatchedCommand = { commandId: string; deviceId: string; initial: DeviceCommand };

/**
 * One run target: label, device picker (online first, offline disabled) and a
 * Run button. After dispatch it polls the command's status via
 * useDeviceCommands and shows it inline.
 */
function RunTargetRow({
  target,
  repository,
  branch,
  taskId,
  dispatched,
  onDispatched,
}: {
  target: TaskRunTarget;
  repository: Repository;
  branch: string;
  taskId: string;
  dispatched: DispatchedCommand | null;
  onDispatched: (dispatched: DispatchedCommand) => void;
}) {
  const createCommand = useCreateDeviceCommand();
  const onlineFirst = [...target.devices].sort((a, b) => Number(b.online) - Number(a.online));
  const defaultDeviceId = onlineFirst.find((device) => device.online)?.id;
  const [chosenDeviceId, setChosenDeviceId] = React.useState<string | null>(null);
  const deviceId = chosenDeviceId ?? defaultDeviceId ?? null;

  const chosenDevice = target.devices.find((device) => device.id === deviceId) ?? null;
  const environment = chosenDevice?.meta?.environment;

  // Concrete install/run target on the chosen machine; reset when the device changes.
  const [installTarget, setInstallTarget] = React.useState<string | null>(null);
  React.useEffect(() => {
    setInstallTarget(null);
  }, [deviceId]);

  const isMobileTarget = target.target === 'android' || target.target === 'ios';
  // environment undefined → the agent never reported capabilities (legacy: no picker).
  const showInstallPicker = isMobileTarget && environment !== undefined;
  const installOptions = showInstallPicker
    ? target.target === 'android'
      ? androidTargetOptions(environment)
      : iosTargetOptions(environment)
    : [];
  const installPickerEmpty = showInstallPicker && installOptions.length === 0;
  const installPlaceholder = installPickerEmpty
    ? target.target === 'android'
      ? 'No Android device reported'
      : 'No iOS device or simulator reported'
    : 'Install target';

  const commands = useDeviceCommands(dispatched?.deviceId ?? null, {
    refetchInterval: dispatched ? 5_000 : false,
  });
  const command = dispatched
    ? (commands.data?.find((item) => item.id === dispatched.commandId) ?? dispatched.initial)
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="w-28 shrink-0 truncate text-sm font-medium">
          {RUN_TARGET_LABELS[target.target]}
        </span>
        {target.devices.length === 0 ? (
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">No paired device</span>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Select
              value={deviceId ?? undefined}
              onValueChange={setChosenDeviceId}
              disabled={Boolean(dispatched) || createCommand.isPending}
            >
              <SelectTrigger className="h-8 min-w-0 flex-1" aria-label="Device">
                <SelectValue placeholder="Select device" />
              </SelectTrigger>
              <SelectContent>
                {onlineFirst.map((device) => (
                  <SelectItem key={device.id} value={device.id} disabled={!device.online}>
                    {device.name}
                    {device.online ? '' : ' (offline)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {showInstallPicker && (
              <Select
                value={installTarget ?? undefined}
                onValueChange={setInstallTarget}
                disabled={installPickerEmpty || Boolean(dispatched) || createCommand.isPending}
              >
                <SelectTrigger className="h-8 min-w-0 flex-1" aria-label="Install target">
                  <SelectValue placeholder={installPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {installOptions.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={'disabled' in option ? option.disabled : false}
                    >
                      {'transport' in option
                        ? `${option.label} · ${transportLabel(option.transport)}`
                        : option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={!deviceId || installPickerEmpty || Boolean(dispatched) || createCommand.isPending}
          onClick={() => {
            if (!deviceId) return;
            createCommand.mutate(
              {
                deviceId,
                type: target.commandType,
                payload: {
                  repoUrl: repository.cloneUrl,
                  branch,
                  ...(installTarget && target.target === 'android'
                    ? { deviceSerial: installTarget }
                    : {}),
                  ...(installTarget && target.target === 'ios'
                    ? { destination: installTarget }
                    : {}),
                },
                taskId,
              },
              { onSuccess: (created) =>
                onDispatched({ commandId: created.id, deviceId, initial: created })
              },
            );
          }}
        >
          {createCommand.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Play className="h-3.5 w-3.5" aria-hidden />
          )}
          Run
        </Button>
        {command && <StatusBadge status={command.status} />}
      </div>
      {installPickerEmpty && (
        <p className="break-words text-xs text-muted-foreground">{installPlaceholder}</p>
      )}
      {(target.target === 'web' || target.target === 'desktop') &&
        chosenDevice &&
        (() => {
          const hint = dockerHint(environment);
          return (
            <p
              className={
                hint.warn
                  ? 'break-words text-xs text-amber-600 dark:text-amber-400'
                  : 'break-words text-xs text-muted-foreground'
              }
            >
              {hint.text}
            </p>
          );
        })()}
      {createCommand.isError && (
        <p className="break-words text-xs text-destructive">
          {describeApiError(createCommand.error)}
        </p>
      )}
      {command?.status === 'failed' && command.result?.error && (
        <p className="break-words text-xs text-destructive">{command.result.error}</p>
      )}
    </div>
  );
}

/**
 * Post-task confirmation: offer each affected run target (android/ios/web/
 * desktop) with the user's paired devices, dispatching a device command on
 * Run. Auto-opened by ConsolePane when a task flips to done; also reachable
 * from the console header button.
 */
export function RunTaskDialog({
  open,
  onOpenChange,
  task,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: SelectedTask;
}) {
  const repositories = useRepositories();
  const repository = repositories.data?.find((repo) => repo.id === task.repositoryId) ?? null;
  const branch = task.branchName ?? repository?.defaultBranch ?? 'main';
  const runTargets = useTaskRunTargets(task.id, open);
  const [dispatched, setDispatched] = React.useState<Record<string, DispatchedCommand>>({});

  // Fresh dispatch state each time the dialog opens.
  React.useEffect(() => {
    if (open) setDispatched({});
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle>Run result on your device?</DialogTitle>
          <DialogDescription>
            {repository ? `${repository.fullName} · ` : ''}branch{' '}
            <code className="text-foreground">{branch}</code>
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-3">
          {(runTargets.isPending || !repository) && (
            <p className="text-sm text-muted-foreground">Loading run targets…</p>
          )}
          {runTargets.isError && (
            <p className="break-words text-sm text-destructive">
              {describeApiError(runTargets.error)}
            </p>
          )}
          {repository &&
            runTargets.data?.map((target) => (
              <RunTargetRow
                key={target.target}
                target={target}
                repository={repository}
                branch={branch}
                taskId={task.id}
                dispatched={dispatched[target.target] ?? null}
                onDispatched={(entry) =>
                  setDispatched((prev) => ({ ...prev, [target.target]: entry }))
                }
              />
            ))}
          {repository && runTargets.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No runnable targets were detected for this task.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
