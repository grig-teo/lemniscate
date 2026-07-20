// Shared micro-utilities. Single home for helpers that were previously
// copy-pasted across agent-loop.ts, llm-client.ts and pull-requests.ts.
// Must stay free of config/prisma/redis imports so every layer (including
// the config-free llm-client) can use it.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Scrubs secrets from text that may reach logs, task events, or errors.
// Empty secrets are skipped (splitting on '' would mangle the text).
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
