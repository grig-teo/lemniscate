import * as React from 'react';
import { Check, Copy, Download } from 'lucide-react';

import { describeApiError } from '@/lib/api';
import {
  AGENT_CLI_ZIP_FILE,
  AGENT_DOWNLOADS,
  AGENT_DOWNLOAD_LINUX_DEBS,
  agentDownloadUrl,
  agentPairCommand,
  detectClientArch,
  detectClientPlatform,
  pairingExpirySeconds,
  type ClientArch,
} from '@/lib/devices';
import { useCreatePairing, useDevices } from '@/lib/hooks';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Copy-to-clipboard button with a brief check confirmation. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

/** 6-char pairing code, large, with a live expiry countdown. */
function PairingCode({ code, expiresAt }: { code: string; expiresAt: string }) {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const secondsLeft = pairingExpirySeconds(expiresAt, now);
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-2">
        <p className="font-mono text-4xl font-semibold tracking-[0.3em]">{code}</p>
        <CopyButton text={code} label="Copy pairing code" />
      </div>
      <p className="text-xs text-muted-foreground">
        {secondsLeft > 0
          ? `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
          : 'Expired — generate a new code'}
      </p>
    </div>
  );
}

/** Download buttons for the desktop agent installers; detected OS+arch is primary. */
function AgentDownloads() {
  const nav = typeof window === 'undefined' ? undefined : window.navigator;
  const clientOs = nav ? detectClientPlatform(nav.userAgent, nav.platform ?? '') : 'unknown';
  const [uaDataArch, setUaDataArch] = React.useState<string | undefined>(undefined);

  // Chromium only: the high-entropy 'architecture' hint ('arm'/'x86') is the
  // only reliable signal on Apple Silicon, where the UA still says "Intel".
  React.useEffect(() => {
    if (!nav) return;
    const uaData = (
      nav as Navigator & {
        userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> };
      }
    ).userAgentData;
    if (!uaData) return;
    let cancelled = false;
    uaData
      .getHighEntropyValues(['architecture'])
      .then((values) => {
        if (!cancelled && values.architecture) setUaDataArch(values.architecture);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clientArch: ClientArch = nav ? detectClientArch(nav.userAgent, uaDataArch) : 'unknown';
  const downloads = [...AGENT_DOWNLOADS, ...AGENT_DOWNLOAD_LINUX_DEBS];
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      <p className="font-medium">Download the desktop app</p>
      <div className="flex flex-wrap gap-2">
        {downloads.map((download) => (
          <a
            key={download.fileName}
            href={agentDownloadUrl(download.fileName)}
            className={buttonVariants({
              variant:
                download.platform === clientOs && download.arch === clientArch
                  ? 'default'
                  : 'outline',
              size: 'sm',
            })}
          >
            <Download className="h-4 w-4" />
            {download.label}
          </a>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Windows: SmartScreen → More info → Run anyway. Linux: App Center warns &ldquo;third
        party&rdquo; — Install still works, or use the AppImage (chmod +x, no install needed).
      </p>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
          macOS: unsigned — if &ldquo;damaged and can&rsquo;t be opened&rdquo;, run once:{' '}
          <code className="text-foreground">
            xattr -dr com.apple.quarantine &quot;/Applications/Lemniscate Agent.app&rdquo;
          </code>
        </p>
        <CopyButton
          text='xattr -dr com.apple.quarantine "/Applications/Lemniscate Agent.app"'
          label="Copy macOS quarantine fix"
        />
      </div>
    </div>
  );
}

/**
 * Pair-a-device dialog: mints a 10-min pairing code on open and shows the
 * agent CLI install/run command. Polls the device list; when the new device
 * shows up it says so and auto-closes.
 */
export function PairingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const pairing = useCreatePairing();
  const devices = useDevices({ refetchInterval: open ? 3_000 : 15_000 });
  const [knownIds, setKnownIds] = React.useState<Set<string> | null>(null);
  const [connectedName, setConnectedName] = React.useState<string | null>(null);

  // Fresh code each time the dialog opens (invalidates any prior code).
  React.useEffect(() => {
    if (!open) return;
    setKnownIds(null);
    setConnectedName(null);
    pairing.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Snapshot the devices known at open; anything new afterwards just paired.
  React.useEffect(() => {
    if (!open || !devices.data || connectedName) return;
    if (knownIds === null) {
      setKnownIds(new Set(devices.data.map((device) => device.id)));
      return;
    }
    const fresh = devices.data.find((device) => !knownIds.has(device.id));
    if (fresh) setConnectedName(fresh.name);
  }, [open, devices.data, knownIds, connectedName]);

  React.useEffect(() => {
    if (!connectedName) return;
    const timer = setTimeout(() => onOpenChange(false), 2_500);
    return () => clearTimeout(timer);
  }, [connectedName, onOpenChange]);

  const origin = window.location.origin;
  const installCommand = pairing.data
    ? agentPairCommand(origin, pairing.data.code)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-full max-w-lg overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
          <DialogDescription>
            Run the Lemniscate agent on the device and enter this code. The code is valid for
            10 minutes; generating a new one invalidates it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-4">
          {pairing.isPending && <p className="text-sm text-muted-foreground">Generating code…</p>}
          {pairing.isError && (
            <p className="break-words text-sm text-destructive">
              {describeApiError(pairing.error)}
            </p>
          )}

          {pairing.data && (
            <>
              <PairingCode code={pairing.data.code} expiresAt={pairing.data.expiresAt} />

              <AgentDownloads />

              <div className="flex min-w-0 flex-col gap-2 text-sm">
                <p className="font-medium">Advanced: CLI agent (Termux/servers)</p>
                <p>
                  On the device, clone this repository (or download the <code>agent/</code>{' '}
                  folder), then run:
                </p>
                <div className="flex items-start gap-2">
                  <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted p-2 font-mono text-xs">
                    {installCommand}
                  </pre>
                  <CopyButton text={installCommand ?? ''} label="Copy install command" />
                </div>
                <div>
                  <a
                    href={agentDownloadUrl(AGENT_CLI_ZIP_FILE)}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    <Download className="h-4 w-4" />
                    Download agent/ folder (.zip)
                  </a>
                </div>
                <p className="text-xs text-muted-foreground">
                  Docker must be installed on the device to run web apps on it.
                </p>
              </div>

              <Button type="button" variant="ghost" size="sm" onClick={() => pairing.mutate()}>
                Generate a new code
              </Button>
            </>
          )}

          {connectedName && (
            <p className="text-sm text-green-600 dark:text-green-400">
              Device connected: {connectedName}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
