// xAI Grok OAuth 2.0 device-code helpers (SuperGrok / X Premium+).
// Protocol constants and pure parsers live here so routes and token
// refresh share one implementation (AGENTS.md §6). Mirrors the Hermes
// xai-oauth flow against auth.x.ai — see docs/guides/xai-grok-oauth.

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
/** Public Grok CLI / Hermes client id used by the device-code grant. */
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1';
/** Default coding model for OAuth-created LLM configs. */
export const XAI_DEFAULT_CODING_MODEL = 'grok-4.5';

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export type DeviceCodeChallenge = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
};

export type OAuthTokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number | null;
  tokenType: string;
};

export type PollError =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'error'; message: string };

export function buildDeviceCodeRequestBody(scope: string = XAI_OAUTH_SCOPE): Record<string, string> {
  return { client_id: XAI_OAUTH_CLIENT_ID, scope };
}

export function buildDeviceTokenPollBody(deviceCode: string): Record<string, string> {
  return {
    grant_type: DEVICE_CODE_GRANT,
    client_id: XAI_OAUTH_CLIENT_ID,
    device_code: deviceCode,
  };
}

export function buildRefreshTokenBody(refreshToken: string): Record<string, string> {
  return {
    grant_type: 'refresh_token',
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  };
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`xAI device-code response missing ${key}`);
  }
  return value.trim();
}

function requirePositiveInt(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`xAI device-code response missing ${key}`);
  }
  return Math.floor(num);
}

export function parseDeviceCodeResponse(payload: unknown): DeviceCodeChallenge {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('xAI device-code response was not a JSON object');
  }
  const data = payload as Record<string, unknown>;
  const verificationUri = requireString(data, 'verification_uri');
  const complete =
    typeof data.verification_uri_complete === 'string' && data.verification_uri_complete.trim()
      ? data.verification_uri_complete.trim()
      : verificationUri;
  return {
    deviceCode: requireString(data, 'device_code'),
    userCode: requireString(data, 'user_code'),
    verificationUrl: complete,
    expiresIn: requirePositiveInt(data, 'expires_in'),
    interval: requirePositiveInt(data, 'interval'),
  };
}

export function parseTokenResponse(payload: unknown): OAuthTokenPair {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('xAI token response was not a JSON object');
  }
  const data = payload as Record<string, unknown>;
  const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token.trim() : '';
  if (!accessToken) throw new Error('xAI token response missing access_token');
  if (!refreshToken) throw new Error('xAI token response missing refresh_token');
  const expiresRaw = data.expires_in;
  const expiresIn =
    typeof expiresRaw === 'number' && Number.isFinite(expiresRaw)
      ? Math.floor(expiresRaw)
      : typeof expiresRaw === 'string' && Number.isFinite(Number(expiresRaw))
        ? Math.floor(Number(expiresRaw))
        : null;
  const tokenType =
    typeof data.token_type === 'string' && data.token_type.trim()
      ? data.token_type.trim()
      : 'Bearer';
  return { accessToken, refreshToken, expiresIn, tokenType };
}

export function parsePollError(payload: unknown): PollError {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: 'error', message: 'xAI device-code poll returned an invalid error payload' };
  }
  const data = payload as Record<string, unknown>;
  const code = typeof data.error === 'string' ? data.error : '';
  if (code === 'authorization_pending') return { kind: 'pending' };
  if (code === 'slow_down') return { kind: 'slow_down' };
  const description =
    (typeof data.error_description === 'string' && data.error_description.trim()) ||
    code ||
    'xAI device-code authorization failed';
  return { kind: 'error', message: description };
}

/** Decode JWT exp claim without verifying the signature (expiry only). */
export function accessTokenExpiresAt(accessToken: string): Date | null {
  if (!accessToken.includes('.')) return null;
  try {
    const parts = accessToken.split('.');
    const middle = parts[1];
    if (!middle) return null;
    const payloadB64 = middle + '='.repeat((4 - (middle.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

export function accessTokenNeedsRefresh(
  accessToken: string,
  skewSeconds = 120,
  now: Date = new Date(),
): boolean {
  const expiresAt = accessTokenExpiresAt(accessToken);
  if (!expiresAt) return false;
  return expiresAt.getTime() <= now.getTime() + skewSeconds * 1000;
}

export async function discoveryUrls(timeoutMs = 15_000): Promise<{ tokenEndpoint: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`xAI OIDC discovery failed (HTTP ${response.status})`);
    }
    const payload = (await response.json()) as { token_endpoint?: unknown };
    const tokenEndpoint =
      typeof payload.token_endpoint === 'string' ? payload.token_endpoint.trim() : '';
    if (!tokenEndpoint.startsWith('https://')) {
      throw new Error('xAI OIDC discovery returned an invalid token_endpoint');
    }
    assertXaiOauthHost(tokenEndpoint, 'token_endpoint');
    return { tokenEndpoint };
  } finally {
    clearTimeout(timer);
  }
}

/** Refuse non-xAI OAuth endpoints so tokens are never POSTed off-domain. */
export function assertXaiOauthHost(url: string, field: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`xAI OAuth ${field} is not a valid URL`);
  }
  if (host !== 'auth.x.ai' && host !== 'accounts.x.ai' && !host.endsWith('.x.ai')) {
    throw new Error(`xAI OAuth ${field} host is not an x.ai domain`);
  }
}

async function postForm(
  url: string,
  body: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function requestDeviceCode(timeoutMs = 20_000): Promise<DeviceCodeChallenge> {
  const response = await postForm(
    XAI_OAUTH_DEVICE_CODE_URL,
    buildDeviceCodeRequestBody(),
    timeoutMs,
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim();
    throw new Error(
      `xAI device-code request failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
    );
  }
  return parseDeviceCodeResponse(await response.json());
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'authorized'; tokens: OAuthTokenPair }
  | { status: 'error'; message: string };

export async function pollDeviceTokenOnce(
  tokenEndpoint: string,
  deviceCode: string,
  timeoutMs = 20_000,
): Promise<DevicePollResult> {
  assertXaiOauthHost(tokenEndpoint, 'token_endpoint');
  const response = await postForm(
    tokenEndpoint,
    buildDeviceTokenPollBody(deviceCode),
    timeoutMs,
  );
  if (response.status === 200) {
    return { status: 'authorized', tokens: parseTokenResponse(await response.json()) };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      status: 'error',
      message: `xAI device-code poll failed (HTTP ${response.status})`,
    };
  }
  const classified = parsePollError(payload);
  if (classified.kind === 'pending') return { status: 'pending' };
  if (classified.kind === 'slow_down') return { status: 'slow_down' };
  return { status: 'error', message: classified.message };
}

export async function refreshXaiAccessToken(
  refreshToken: string,
  tokenEndpoint: string,
  timeoutMs = 20_000,
): Promise<OAuthTokenPair> {
  assertXaiOauthHost(tokenEndpoint, 'token_endpoint');
  const response = await postForm(tokenEndpoint, buildRefreshTokenBody(refreshToken), timeoutMs);
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim();
    throw new Error(
      `xAI token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
    );
  }
  return parseTokenResponse(await response.json());
}
