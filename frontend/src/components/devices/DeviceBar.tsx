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

function DeviceButton({ device, onClick }: { device: Device; onClick: () => void }) {
  const Icon = platformIcon(device.platform);
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${device.name} (${device.online ? 'online' : 'offline'})`}
      aria-label={`Device ${device.name}`}
      className="relative rounded-full p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Icon className="h-4 w-4" />
      <span
        className={cn(
          'absolute right-1 top-1 h-2 w-2 rounded-full',
          device.online ? 'bg-green-500' : 'bg-gray-400',
        )}
      />
    </button>
  );
}

/**
 * Dock strip anchored to the bottom-right of the shell: one icon button per
 * paired device (opening its details modal) plus a "+" that opens the
 * pairing dialog. The "+" is always shown so pairing is discoverable.
 */
export function DeviceBar() {
  const devices = useDevices();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = React.useState(false);
  const selected = (devices.data ?? []).find((device) => device.id === selectedId) ?? null;

  return (
    <>
      <div className="fixed bottom-4 right-4 z-40 flex items-center gap-1 rounded-full border bg-background/95 px-2 py-1 shadow-lg backdrop-blur">
        {(devices.data ?? []).map((device) => (
          <DeviceButton key={device.id} device={device} onClick={() => setSelectedId(device.id)} />
        ))}
        <button
          type="button"
          onClick={() => setPairingOpen(true)}
          title="Pair a device"
          aria-label="Pair a device"
          className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
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
