import { AlertTriangle, Settings } from 'lucide-react';
import { FormattedMessage } from 'react-intl';

import {
  getErrorBannerInfo,
  hasActionableError,
  openSettingsTab,
} from '@/lib/error-codes';
import { Button } from '@/components/ui/button';

// English copy for the banner messages (the extracted en.json source);
// translated catalogs override these via the message ids in ErrorBannerInfo.
const ERROR_DEFAULTS: Record<string, { title: string; hint: string }> = {
  LLM_AUTH_FAILED: {
    title: 'LLM API key is invalid or unauthorized',
    hint: 'The LLM provider rejected the API key. Update the key or switch to a working config, then rerun the task.',
  },
  LLM_RATE_LIMITED: {
    title: 'LLM rate limit reached',
    hint: 'Too many requests were sent to the LLM provider. Wait a moment and rerun, or reduce the requests-per-minute in the config.',
  },
  LLM_QUOTA_EXCEEDED: {
    title: 'LLM quota or billing limit exceeded',
    hint: 'The LLM provider reports insufficient quota. Add billing credits on the provider side or switch to a different config.',
  },
  LLM_TIMEOUT: {
    title: 'The LLM request timed out',
    hint: 'The provider did not respond within the timeout. Increase the timeout in the LLM config or retry.',
  },
  LLM_CONNECTION_FAILED: {
    title: 'Cannot connect to the LLM endpoint',
    hint: 'The LLM base URL is unreachable (DNS, network, or firewall). Check the base URL and server availability.',
  },
  LLM_SERVER_ERROR: {
    title: 'The LLM provider returned a server error',
    hint: 'The provider is experiencing issues (HTTP 5xx). Retry shortly; if it persists, check the provider status page.',
  },
  GIT_AUTH_FAILED: {
    title: 'Git authentication failed',
    hint: 'The repository token is missing or invalid. Reconnect the Git provider to refresh the token.',
  },
  GIT_PERMISSION_DENIED: {
    title: 'Git push permission denied',
    hint: 'The token does not have write access to this repository. Grant push permission or reconnect with the right scopes.',
  },
  GIT_WORKFLOW_SCOPE: {
    title: 'Missing GitHub "workflow" scope',
    hint: 'The task edited .github/workflows but the token lacks the workflow OAuth scope. Reconnect GitHub to grant it, then rerun.',
  },
  PROPOSAL_GENERATION_FAILED: {
    title: 'Autonomous proposal generation failed',
    hint: 'The background pipeline could not generate proposals after multiple retries. Check the LLM config and try again, or trigger proposals manually.',
  },
  UNKNOWN: {
    title: 'Task failed with an unexpected error',
    hint: 'Check the console log below for details. If the issue persists, retry the task.',
  },
};

/**
 * Prominent error banner shown above the console log when a task fails.
 * Maps the backend errorCode to a user-friendly title + hint (translated
 * via react-intl) and, when a direct fix exists, a button that opens the
 * relevant settings tab.
 */
export function ErrorBanner({ errorCode }: { errorCode: string | null | undefined }) {
  if (!errorCode) return null;
  const info = getErrorBannerInfo(errorCode);
  const defaults = ERROR_DEFAULTS[info.code] ?? ERROR_DEFAULTS.UNKNOWN!;
  const actionable = hasActionableError(errorCode);
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-3 border-b border-red-500/20 bg-red-500/5 px-4 py-3"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-red-700 dark:text-red-300">
          <FormattedMessage id={info.titleId} defaultMessage={defaults.title} />
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <FormattedMessage id={info.hintId} defaultMessage={defaults.hint} />
        </p>
      </div>
      {actionable && info.settingsTab && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5 text-xs"
          onClick={() => openSettingsTab(info.settingsTab!)}
        >
          <Settings className="h-3.5 w-3.5" aria-hidden />
          <FormattedMessage id="error.banner.fix" defaultMessage="Fix" />
        </Button>
      )}
    </div>
  );
}
