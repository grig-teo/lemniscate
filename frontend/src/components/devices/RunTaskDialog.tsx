import * as React from 'react';
import { Loader2, Play } from 'lucide-react';

import { describeApiError } from '@/lib/api';
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
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={!deviceId || Boolean(dispatched) || createCommand.isPending}
          onClick={() => {
            if (!deviceId) return;
            createCommand.mutate(
              {
                deviceId,
                type: target.commandType,
                payload: { repoUrl: repository.cloneUrl, branch },
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
