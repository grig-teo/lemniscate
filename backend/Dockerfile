# ---------- deps: install all dependencies ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---------- build: compile TypeScript ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate \
  && npm run build
# NOTE: no `npm prune --omit=dev` here — the prisma CLI (a devDependency)
# must stay in node_modules so the runtime CMD can run
# `npx prisma migrate deploy` before starting the API server.

# ---------- runtime: slim production image ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# git: the worker clones repositories; openssl: required by Prisma engines on alpine.
# bash/curl/xz/ripgrep: prerequisites of the Hermes Agent CLI installer below.
RUN apk add --no-cache git openssl bash curl xz ripgrep \
  && addgroup -S app && adduser -S app -G app
# Hermes Agent CLI: the worker runs `hermes chat -q ...` inside cloned repos.
# Installed as root, so the script uses its FHS layout: code at
# /usr/local/lib/hermes-agent, launcher at /usr/local/bin/hermes (on PATH for
# the app user), uv-managed Python under /usr/local/share/uv (world-readable).
# --skip-browser avoids the Playwright/Chromium download; --skip-setup avoids
# the interactive wizard. Data/config land in the invoking user's ~/.hermes.
# Cleanup: browser-tool node_modules are unused with --skip-browser; the
# installer caches and root's seeded data dir are dead weight for the app user.
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
  | bash -s -- --skip-browser --skip-setup \
  && rm -rf /usr/local/lib/hermes-agent/node_modules \
    /root/.cache /root/.hermes
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/scripts ./scripts
USER app
EXPOSE 3000
# API server entrypoint: apply migrations, then start.
# The compose `worker` service overrides this with `node dist/worker.js`
# to run the BullMQ consumer instead — the worker must NOT run migrations.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
