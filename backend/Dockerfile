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
RUN apk add --no-cache git openssl \
  && addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/prisma ./prisma
USER app
EXPOSE 3000
# API server entrypoint: apply migrations, then start.
# The compose `worker` service overrides this with `node dist/worker.js`
# to run the BullMQ consumer instead — the worker must NOT run migrations.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
