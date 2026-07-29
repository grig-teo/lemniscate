import { MONITORED_SECRETS } from '../config.js';
import { decrypt } from './crypto.js';
import { prisma } from './prisma.js';

// Failure-message scrubbing helpers. Extracted from notifications.ts.

// Connection fields needed to scrub a failure message before it reaches the
// in-app bell or an outbound channel payload.
interface FailureSecretSource {
  userId: string;
  accessTokenEnc: string | null;
  refreshTokenEnc?: string | null;
}

function pushDecrypted(secrets: string[], enc: string): void {
  try {
    secrets.push(decrypt(enc));
  } catch {
    // Undecryptable row (key rotation, soft-disconnect): skip it rather than
    // fail the notification.
  }
}

// Secrets scrubbed from failure messages: config-level MONITORED_SECRETS
// plus the owning connection's git token(s) and every LLM API key the user
// has saved. Worker-level failures (worker.ts 'failed' hook) arrive with a
// raw err.message that bypasses recordJobFailure's in-run scrub, so this is
// the last line of defense before user-facing channels.
export async function failureSecrets(connection: FailureSecretSource): Promise<string[]> {
  const secrets = [...MONITORED_SECRETS];
  for (const enc of [connection.accessTokenEnc, connection.refreshTokenEnc]) {
    if (enc) pushDecrypted(secrets, enc);
  }
  const configs = await prisma.llmConfig.findMany({
    where: { userId: connection.userId },
    select: { apiKeyEnc: true, refreshTokenEnc: true },
  });
  for (const cfg of configs) {
    pushDecrypted(secrets, cfg.apiKeyEnc);
    if (cfg.refreshTokenEnc) pushDecrypted(secrets, cfg.refreshTokenEnc);
  }
  return secrets;
}
