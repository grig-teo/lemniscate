import { oauthStartUrl } from '@/lib/api';
import { providerLabel, ProviderIcon } from '@/lib/providers';
import { Button } from '@/components/ui/button';

function connectTo(provider: 'github' | 'gitlab') {
  window.location.href = oauthStartUrl(provider);
}

function OauthConnectButton({ provider, className }: { provider: 'github' | 'gitlab'; className?: string }) {
  return (
    <Button variant="outline" className={className} onClick={() => connectTo(provider)}>
      <ProviderIcon provider={provider} className="h-4 w-4" />
      Connect {providerLabel(provider)}
    </Button>
  );
}

/**
 * The three "Connect …" buttons (GitHub/GitLab via OAuth redirect, GitVerse
 * via token dialog). Shared by the login page and the settings dialog.
 */
export function ConnectProviderButtons({
  onGitverse,
  className,
}: {
  onGitverse: () => void;
  className?: string;
}) {
  return (
    <>
      <OauthConnectButton provider="github" className={className} />
      <OauthConnectButton provider="gitlab" className={className} />
      <Button variant="outline" className={className} onClick={onGitverse}>
        <ProviderIcon provider="gitverse" className="h-4 w-4" />
        Connect {providerLabel('gitverse')}
      </Button>
    </>
  );
}
