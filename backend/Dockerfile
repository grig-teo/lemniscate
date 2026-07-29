# ---------- deps: install all dependencies ----------
FROM node:24.18.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---------- build: compile TypeScript ----------
FROM node:24.18.0-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate \
  && npm run build
# NOTE: no `npm prune --omit=dev` here — the prisma CLI (a devDependency)
# must stay in node_modules so the runtime CMD can run
# `npx prisma migrate deploy` before starting the API server.

# ---------- runtime: slim production image ----------
FROM node:24.18.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# git: the worker clones repositories; openssl: required by Prisma engines on alpine.
# bash/curl/xz/ripgrep: prerequisites of the Hermes Agent CLI installer below.
# tar: cleanupWorkdir snapshots workdirs into MinIO tarballs before removal.
# docker-cli: the deploy-service job builds/starts user service containers
# via the mounted host docker socket (compose mounts /var/run/docker.sock).
# openssh+sshpass: the VPS deploy path (lib/deploy/vps.ts) shells out to the
# `ssh` and `sshpass` CLIs to deploy onto a user's own server.
# python3+pip: lemcore installs code-review-graph (PyPI) to build a codebase
# graph on every repository scan and cut implementation-context tokens.
RUN apk add --no-cache git openssl bash curl xz ripgrep tar docker-cli openssh sshpass \
    python3 py3-pip \
  && addgroup -S app && adduser -S app -G app \
  && pip3 install --break-system-packages --no-cache-dir 'code-review-graph==2.3.7'
# Hermes Agent CLI: the worker runs `hermes chat -q ...` inside cloned repos.
# Installed as root, so the script uses its FHS layout: code at
# /usr/local/lib/hermes-agent, launcher at /usr/local/bin/hermes (on PATH for
# the app user), uv-managed Python under /usr/local/share/uv (world-readable).
# --skip-browser avoids the Playwright/Chromium download; --skip-setup avoids
# the interactive wizard. Data/config land in the invoking user's ~/.hermes.
#
# Supply chain: there is no versioned installer URL, but install.sh accepts
# --commit to pin the checked-out hermes-agent revision. HERMES_COMMIT pins
# that revision (override with --build-arg to upgrade deliberately). The
# install.sh script itself is still fetched unpinned — a residual risk that
# only a vendored installer or checksum verification would fully close.
# Cleanup: browser-tool node_modules are unused with --skip-browser; the
# installer caches and root's seeded data dir are dead weight for the app user.
ARG HERMES_COMMIT=d48d6fadff6a2135110925a807a9d076c7ae958c
# e2e builds set SKIP_HERMES_INSTALL=1: the smoke suite uses the 'internal'
# executor, and skipping the network-fetched installer keeps the e2e image
# build fast and independent of external availability. Production builds
# leave it unset.
ARG SKIP_HERMES_INSTALL=""
RUN if [ "$SKIP_HERMES_INSTALL" != "1" ]; then \
      curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
        | bash -s -- --skip-browser --skip-setup --commit "$HERMES_COMMIT" \
      && rm -rf /usr/local/lib/hermes-agent/node_modules \
        /root/.cache /root/.hermes; \
    fi
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/scripts ./scripts
# Task workdir mountpoint: named volumes initialize with the image's owner,
# so this must belong to app or every clone fails with EACCES.
RUN mkdir -p /tmp/lemniscate-repos && chown app:app /tmp/lemniscate-repos
USER app
EXPOSE 3000
# API server entrypoint: apply migrations, then start.
# The compose `worker` service overrides this with `node dist/worker.js`
# to run the BullMQ consumer instead — the worker must NOT run migrations.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
