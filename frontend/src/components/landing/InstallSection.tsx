import * as React from 'react';

import { cn } from '@/lib/utils';

type Platform = 'linux' | 'macos';

const INSTALL_BASE =
  'curl -fsSL https://raw.githubusercontent.com/grig-teo/lemniscate/main/scripts/install-';

const INSTALL_COMMANDS: Record<Platform, string> = {
  linux: `${INSTALL_BASE}linux.sh | bash`,
  macos: `${INSTALL_BASE}macos.sh | bash`,
};

const PLATFORM_LABELS: Record<Platform, string> = { linux: 'Linux', macos: 'macOS' };

/** execCommand fallback for browsers without the async clipboard API. */
function legacyCopy(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } catch {
    // Copy is best-effort.
  }
  document.body.removeChild(textarea);
}

async function copyToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) return legacyCopy(text);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    legacyCopy(text);
  }
}

function PlatformToggle({
  platform,
  onSelect,
}: {
  platform: Platform;
  onSelect: (platform: Platform) => void;
}) {
  return (
    <div className="mb-4 flex gap-2" role="tablist">
      {(Object.keys(INSTALL_COMMANDS) as Platform[]).map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={platform === key}
          onClick={() => onSelect(key)}
          className={cn(
            'flex-1 rounded-md border py-2 font-mono text-sm text-muted-foreground transition-colors hover:text-foreground',
            platform === key &&
              'border-foreground bg-foreground font-semibold text-background hover:text-background',
          )}
        >
          {PLATFORM_LABELS[key]}
        </button>
      ))}
    </div>
  );
}

/** One-liner install command with a Linux/macOS toggle and a copy button. */
export function InstallSection() {
  const [platform, setPlatform] = React.useState<Platform>('linux');
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    void copyToClipboard(INSTALL_COMMANDS[platform]).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <section aria-label="Install" className="mt-12 rounded-lg border bg-card p-5">
      <PlatformToggle platform={platform} onSelect={setPlatform} />
      <div className="flex items-stretch gap-2">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap rounded-md border bg-background px-3 py-2.5 font-mono text-xs">
          <span className="mr-2 select-none text-muted-foreground">$</span>
          <code>{INSTALL_COMMANDS[platform]}</code>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="whitespace-nowrap rounded-md border px-4 font-mono text-xs transition-colors hover:bg-accent"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        This script installs Docker if it is not installed yet, then deploys Lemniscate via Docker
        Compose.
      </p>
    </section>
  );
}
