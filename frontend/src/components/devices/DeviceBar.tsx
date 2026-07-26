import * as React from 'react';
import { Globe, Monitor, Plus, Smartphone } from 'lucide-react';

import { useDevices, type Device } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { DeviceDetailsModal } from '@/components/devices/DeviceDetailsModal';
import { PairingDialog } from '@/components/devices/PairingDialog';

function platformIcon(platform: string) {
  if (platform === 'desktop') return Monitor;
  if (platform === 'android' || platform === 'ios') return Smartphone;
  return Globe;
}

function DeviceRow({ device, onClick }: { device: Device; onClick: () => void }) {
  const Icon = platformIcon(device.platform);
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${device.name} (${device.online ? 'online' : 'offline'})`}
      aria-label={`Device ${device.name}`}
      className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{device.name}</span>
      <span
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          device.online ? 'bg-green-500' : 'bg-gray-400',
        )}
      />
    </button>
  );
}

/**
 * Static section pinned to the bottom of the left sidebar (rendered by
 * RepoTree after the scrollable repo list): a "Devices" header with a "+"
 * pairing button and one named row per paired device (opening its details
 * modal). Rows never scroll away with the repo list; the "+" is always
 * visible so pairing is discoverable.
 */
export function DeviceBar() {
  const devices = useDevices();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = React.useState(false);
  const selected = (devices.data ?? []).find((device) => device.id === selectedId) ?? null;

  return (
    <>
      <div className="shrink-0 border-t bg-card px-2 py-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Devices
          </span>
          <button
            type="button"
            onClick={() => setPairingOpen(true)}
            title="Pair a device"
            aria-label="Pair a device"
            className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-0.5 flex flex-col gap-0.5">
          {(devices.data ?? []).map((device) => (
            <DeviceRow key={device.id} device={device} onClick={() => setSelectedId(device.id)} />
          ))}
          {(devices.data ?? []).length === 0 && (
            <p className="px-1.5 py-1 text-xs text-muted-foreground/70">
              No devices paired — click + to connect one.
            </p>
          )}
        </div>
      </div>

      <PairingDialog open={pairingOpen} onOpenChange={setPairingOpen} />
      <DeviceDetailsModal
        device={selected}
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </>
  );
}
