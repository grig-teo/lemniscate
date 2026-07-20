import * as React from 'react';
import { Infinity as InfinityIcon, Loader2 } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';

import { ConnectProviderButtons } from '@/components/ConnectProviderButtons';
import { GitVerseConnectDialog } from '@/components/GitVerseConnectDialog';
import { useMe } from '@/lib/hooks';

function LoginCard({ onGitverse }: { onGitverse: () => void }) {
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-lg border bg-card p-8 shadow-sm">
      <div className="flex flex-col items-center gap-2">
        <InfinityIcon className="h-10 w-10 text-foreground" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">Lemniscate</h1>
        <p className="text-center text-sm text-muted-foreground">
          Connect a git host to get started.
        </p>
      </div>

      <div className="flex w-full flex-col gap-2">
        <ConnectProviderButtons onGitverse={onGitverse} className="w-full" />
      </div>

      <p className="text-xs text-muted-foreground/70">
        GitVerse sign-in uses a personal access token instead of OAuth.
      </p>
    </div>
  );
}

/**
 * /login — GitHub/GitLab sign in via a full-page OAuth redirect;
 * GitVerse connects with a personal access token instead.
 * Already-authenticated visitors bounce straight back to '/'.
 */
export function LoginPage() {
  const me = useMe();
  const navigate = useNavigate();
  const [gitverseOpen, setGitverseOpen] = React.useState(false);

  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }

  if (me.data) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <LoginCard onGitverse={() => setGitverseOpen(true)} />

      <GitVerseConnectDialog
        open={gitverseOpen}
        onOpenChange={setGitverseOpen}
        onConnected={() => navigate('/')}
      />
    </div>
  );
}
