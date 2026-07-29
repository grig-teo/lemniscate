-- xAI (and future) OAuth credentials on LlmConfig: access token stays in
-- apiKeyEnc (Bearer), refresh + expiry + cached token endpoint ride along.
ALTER TABLE "LlmConfig" ADD COLUMN "authType" TEXT NOT NULL DEFAULT 'api_key';
ALTER TABLE "LlmConfig" ADD COLUMN "refreshTokenEnc" TEXT;
ALTER TABLE "LlmConfig" ADD COLUMN "tokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "LlmConfig" ADD COLUMN "oauthTokenEndpoint" TEXT;
