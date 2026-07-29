import { decrypt, encrypt } from './crypto.js';
import { prisma } from './prisma.js';
import {
  accessTokenExpiresAt,
  accessTokenNeedsRefresh,
  refreshXaiAccessToken,
  type OAuthTokenPair,
} from './xai-oauth.js';

// Single home for turning an LlmConfig row into a usable Bearer token.
// API-key configs decrypt apiKeyEnc; OAuth configs refresh when the JWT is
// near expiry and persist the rotated pair (AGENTS.md §6).

const OAUTH_REFRESH_SKEW_SECONDS = 120;

export const LLM_OAUTH_RECONNECT_MESSAGE =
  'LLM OAuth session expired — reconnect xAI in Settings → LLM configs';

export type LlmAuthFields = {
  id: string;
  apiKeyEnc: string;
  authType?: string | null;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: Date | null;
  oauthTokenEndpoint?: string | null;
};

function isOauth(config: LlmAuthFields): boolean {
  return config.authType === 'oauth';
}

function expiryFromTokens(tokens: OAuthTokenPair, now = new Date()): Date | null {
  const fromJwt = accessTokenExpiresAt(tokens.accessToken);
  if (fromJwt) return fromJwt;
  if (tokens.expiresIn == null) return null;
  return new Date(now.getTime() + tokens.expiresIn * 1000);
}

async function persistRefreshedTokens(configId: string, tokens: OAuthTokenPair): Promise<void> {
  await prisma.llmConfig.update({
    where: { id: configId },
    data: {
      apiKeyEnc: encrypt(tokens.accessToken),
      refreshTokenEnc: encrypt(tokens.refreshToken),
      tokenExpiresAt: expiryFromTokens(tokens),
    },
  });
}

async function refreshOauthConfig(config: LlmAuthFields): Promise<string> {
  if (!config.refreshTokenEnc) {
    throw new Error(LLM_OAUTH_RECONNECT_MESSAGE);
  }
  const tokenEndpoint = config.oauthTokenEndpoint?.trim();
  if (!tokenEndpoint) {
    throw new Error(LLM_OAUTH_RECONNECT_MESSAGE);
  }
  const refreshToken = decrypt(config.refreshTokenEnc);
  const tokens = await refreshXaiAccessToken(refreshToken, tokenEndpoint);
  await persistRefreshedTokens(config.id, tokens);
  return tokens.accessToken;
}

function oauthAccessNeedsRefresh(config: LlmAuthFields, accessToken: string): boolean {
  if (accessTokenNeedsRefresh(accessToken, OAUTH_REFRESH_SKEW_SECONDS)) return true;
  if (!config.tokenExpiresAt) return false;
  return config.tokenExpiresAt.getTime() <= Date.now() + OAUTH_REFRESH_SKEW_SECONDS * 1000;
}

/** Decrypt (and refresh when needed) the Bearer token for an LLM config. */
export async function resolveLlmAccessToken(config: LlmAuthFields): Promise<string> {
  if (!isOauth(config)) {
    return decrypt(config.apiKeyEnc);
  }
  if (!config.refreshTokenEnc) {
    throw new Error(LLM_OAUTH_RECONNECT_MESSAGE);
  }
  const accessToken = decrypt(config.apiKeyEnc);
  if (!oauthAccessNeedsRefresh(config, accessToken)) {
    return accessToken;
  }
  return refreshOauthConfig(config);
}
