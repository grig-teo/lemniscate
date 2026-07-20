import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { useCreateConnection } from '@/lib/hooks';

const DEFAULT_BASE_URL = 'https://gitverse.ru';

/** Token/base-URL state and the connect mutation for the dialog. */
function useGitVerseConnect(onOpenChange: (open: boolean) => void, onConnected?: () => void) {
  const [token, setToken] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState(DEFAULT_BASE_URL);
  const createConnection = useCreateConnection();

  function handleOpenChange(next: boolean) {
    if (!next) {
      setToken('');
      setBaseUrl(DEFAULT_BASE_URL);
      createConnection.reset();
    }
    onOpenChange(next);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedToken = token.trim();
    if (!trimmedToken) return;
    const trimmedBaseUrl = baseUrl.trim();
    createConnection.mutate(
      {
        provider: 'gitverse',
        token: trimmedToken,
        baseUrl: trimmedBaseUrl && trimmedBaseUrl !== DEFAULT_BASE_URL ? trimmedBaseUrl : undefined,
      },
      {
        onSuccess: () => {
          handleOpenChange(false);
          onConnected?.();
        },
      },
    );
  }

  return { token, setToken, baseUrl, setBaseUrl, createConnection, handleOpenChange, submit };
}

function TokenFields({
  token,
  setToken,
  baseUrl,
  setBaseUrl,
}: {
  token: string;
  setToken: (value: string) => void;
  baseUrl: string;
  setBaseUrl: (value: string) => void;
}) {
  return (
    <>
      <FormField label="Access token">
        <Input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="gvt_…"
          autoComplete="off"
          required
        />
      </FormField>
      <FormField label="Base URL (optional)">
        <Input
          type="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={DEFAULT_BASE_URL}
        />
      </FormField>
    </>
  );
}

/**
 * GitVerse has no OAuth flow — users paste a personal access token instead.
 * Shared by the login page and the settings dialog.
 */
export function GitVerseConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Extra callback after a successful connect (e.g. navigate to '/' on login). */
  onConnected?: () => void;
}) {
  const state = useGitVerseConnect(onOpenChange, onConnected);

  return (
    <Dialog open={open} onOpenChange={state.handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect GitVerse</DialogTitle>
          <DialogDescription>
            Paste a GitVerse personal access token. Leave the base URL unchanged for gitverse.ru.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={state.submit} className="flex flex-col gap-3">
          <TokenFields
            token={state.token}
            setToken={state.setToken}
            baseUrl={state.baseUrl}
            setBaseUrl={state.setBaseUrl}
          />

          {state.createConnection.isError && (
            <p className="text-sm text-destructive">{state.createConnection.error.message}</p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={state.createConnection.isPending || !state.token.trim()}>
              {state.createConnection.isPending ? 'Connecting…' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
