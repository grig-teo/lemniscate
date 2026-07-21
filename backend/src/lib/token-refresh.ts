import { config } from '../config.js';
import { decrypt, encrypt } from './crypto.js';
import { ProviderError } from './git-providers.js';
import { prisma } from './prisma.js';

// GitLab OAuth access tokens expire after ~2 hours. This module is the
// single home for keeping them alive: OAuth login stores the refresh token
// and expiry on the connection (migration 0006), and every API call resolves
// its token through here instead of decrypting accessTokenEnc directly.
// Expired tokens are swapped transparently; legacy rows without an expiry
// recover via a single refresh+retry on a 401 (withGitlabRefreshRetry).

// Refresh this far ahead of the real expiry so a token never dies mid-call.
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

export const GITLAB_TOKEN_URL = 'https://gitlab.com/oauth/token';

// The message the UI/agent loop records when the refresh grant is rejected —
// it must tell the user exactly how to recover.
export const GITLAB_REFRESH_FAILURE_MESSAGE =
  'gitlab: token refresh failed — reconnect GitLab in Settings';

// A connection row as needed for token resolution. Fields beyond
// accessTokenEnc are optional so partial selections (and tests) still work.
export interface StoredTokenConnection {
  id?: string;
  provider: string;
  tokenType?: string | null;
  accessTokenEnc: string;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: Date | null;
}

// A missing expiry means "unknown", not "expired": legacy rows get their
// chance through the 401 retry instead.
export function tokenIsExpired(
  expiresAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return expiresAt != null && expiresAt.getTime() <= now.getTime();
}

// Expiry instant from GitLab's expires_in (seconds), minus the safety margin.
export function tokenExpiryFromNow(expiresInSeconds: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + expiresInSeconds * 1000 - EXPIRY_SAFETY_MARGIN_MS);
}

// Pure request builder for the refresh_token grant; exported for tests.
export function buildRefreshRequestBody(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): string {
  return JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

// Only GitLab OAuth connections with a stored refresh token can refresh.
function canRefresh(connection: StoredTokenConnection): boolean {
  return (
    connection.provider === 'gitlab' &&
    connection.tokenType === 'oauth' &&
    Boolean(connection.id && connection.refreshTokenEnc)
  );
}

interface RefreshTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

// Exchanges the stored refresh token for a fresh access token and persists
// the rotated pair (GitLab rotates refresh tokens on every refresh).
async function refreshAccessToken(connection: StoredTokenConnection): Promise<string> {
  const refreshToken = decrypt(connection.refreshTokenEnc as string);
  let response: Response;
  try {
    response = await fetch(GITLAB_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: buildRefreshRequestBody(
        refreshToken,
        config.GITLAB_CLIENT_ID ?? '',
        config.GITLAB_CLIENT_SECRET ?? '',
      ),
    });
  } catch {
    throw new ProviderError(GITLAB_REFRESH_FAILURE_MESSAGE);
  }
  const data = (await response.json().catch(() => null)) as RefreshTokenResponse | null;
  if (!response.ok || !data?.access_token || !data.refresh_token) {
    throw new ProviderError(GITLAB_REFRESH_FAILURE_MESSAGE, response.status);
  }
  await prisma.gitConnection.update({
    where: { id: connection.id as string },
    data: {
      accessTokenEnc: encrypt(data.access_token),
      refreshTokenEnc: encrypt(data.refresh_token),
      tokenExpiresAt: data.expires_in ? tokenExpiryFromNow(data.expires_in) : null,
    },
  });
  return data.access_token;
}

// Resolves the access token for a connection, refreshing first when the
// stored GitLab OAuth token is expired. Everything else gets the stored
// token as-is.
export async function getValidAccessToken(connection: StoredTokenConnection): Promise<string> {
  if (canRefresh(connection) && tokenIsExpired(connection.tokenExpiresAt)) {
    return refreshAccessToken(connection);
  }
  return decrypt(connection.accessTokenEnc);
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof ProviderError && err.status === 401;
}

// Runs fn with a valid access token. When a refreshable GitLab OAuth
// connection still gets a 401 (legacy rows carry no tokenExpiresAt, so the
// expiry is only discovered when a call fails), refreshes once and retries.
// Any other error — or a connection without a refresh token — is rethrown.
export async function withGitlabRefreshRetry<T>(
  connection: StoredTokenConnection,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const token = await getValidAccessToken(connection);
  try {
    return await fn(token);
  } catch (err) {
    if (!canRefresh(connection) || !isUnauthorized(err)) throw err;
    const refreshed = await refreshAccessToken(connection);
    return fn(refreshed);
  }
}
