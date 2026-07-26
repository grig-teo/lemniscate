import type { ProviderName } from './types.js';
import { githubWebhookApi } from './webhook-github.js';
import { gitlabWebhookApi } from './webhook-gitlab.js';
import type { ProviderWebhookApi } from './webhook-types.js';

// The webhook provider registry: the ONE place a provider's webhook API is
// selected by name (AGENTS.md §4). Only GitHub and GitLab support inbound
// webhooks initially; GitVerse and Gitee return null (the pr-state-sync
// poller remains the only source of PR-state transitions for those).

const webhookApis: Partial<Record<ProviderName, ProviderWebhookApi>> = {
  github: githubWebhookApi,
  gitlab: gitlabWebhookApi,
};

/** Returns the webhook API for a provider, or null when unsupported. */
export function getProviderWebhookApi(provider: ProviderName): ProviderWebhookApi | null {
  return webhookApis[provider] ?? null;
}
