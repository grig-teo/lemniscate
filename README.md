# Lemniscate

A web app that continuously improves your codebase with an LLM in the loop:
log in with GitHub or GitLab (or a GitVerse token), connect your own LLM (base URL, API key, model name),
and the agent analyzes your repositories, proposes improvements/features/fixes,
generates the code, pushes a branch, and opens pull requests — on a configurable schedule.

## Quick install

One command per platform — the script installs Docker if needed, clones the
repo, prepares `.env` files (generating `JWT_SECRET` / `ENCRYPTION_KEY`),
and starts the full stack via Docker Compose:

```bash
# Linux
curl -fsSL https://raw.githubusercontent.com/grig-teo/lemniscate/main/scripts/install-linux.sh | bash

# macOS
curl -fsSL https://raw.githubusercontent.com/grig-teo/lemniscate/main/scripts/install-macos.sh | bash
```

Both scripts are idempotent (safe to re-run). A landing page with the same
commands lives at `landing/index.html` — open it directly in a browser or
serve it via any static pages hosting.

## Tech stack

- **Backend** — Node.js 22, TypeScript, Fastify, Prisma, PostgreSQL 16
- **Queue** — Redis + BullMQ (agent loop runs as background jobs)
- **Worker** — separate service (same image) that clones repos, runs the LLM loop, commits and opens PRs
- **Frontend** — React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query
- **Auth** — OAuth 2.0 via GitHub and GitLab; GitVerse via personal access token
- **LLM** — any OpenAI-compatible `/v1/chat/completions` endpoint, configured per user
  in the web UI (base URL, API key, model name, generation parameters).
  Works with OpenAI, Azure, vLLM, Ollama, LM Studio, and compatible gateways

## Project layout

```
docker-compose.yml    # postgres, redis, backend, worker, frontend
backend/              # Fastify API + BullMQ worker (Dockerfile, .env.example)
frontend/             # Vite/React app served by nginx (Dockerfile, .env.example)
```

## Getting started

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# fill in OAuth client IDs/secrets and secrets, then:
docker compose up --build
```

- Frontend: http://localhost:8080
- Backend API: http://localhost:3000

## OAuth app setup

Login is via GitHub or GitLab OAuth. Register an OAuth app at each provider
you want to support; the callback URL is `{BACKEND_URL}/api/auth/{provider}/callback`
(with the default env that means):

- **GitHub** (https://github.com/settings/developers → New OAuth App)
  - Callback: `http://localhost:3000/api/auth/github/callback`
  - Scopes requested by the app: `repo`, `read:user`, `read:org`
  - Set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in `backend/.env`
  - Must be a classic **OAuth App**, not a **GitHub App** (client IDs starting
    with `Iv`). GitHub App tokens carry no OAuth scopes, so pushes fail with
    a 403 and organization repositories never sync; the login route rejects
    such a client ID with an explicit error.
- **GitLab** (https://gitlab.com/-/user_settings/applications, or your
  self-managed instance)
  - Callback: `http://localhost:3000/api/auth/gitlab/callback`
  - Scopes requested by the app: `api`, `read_user`
  - Set `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` in `backend/.env`

If a provider's env vars are empty, its login button fails with a clear error;
the other provider still works.

## GitVerse (PAT flow)

GitVerse has no OAuth login here. Instead, connect it with a **personal
access token** from the UI: create a PAT on GitVerse, then use "Add
connection" → GitVerse and paste the token. The PAT itself identifies your
account, so the first GitVerse connection also creates your user session —
you can use the app with GitVerse alone, no OAuth provider required.
GitHub/GitLab connections can also be added by PAT the same way.

## Manual end-to-end test checklist

The automated verification covers build, migrations, and unauthenticated API
responses. The full agent flow needs real credentials and must be exercised
by hand:

1. Create the OAuth apps above and fill in `backend/.env` (also set
   `JWT_SECRET` and a 64-hex-char `ENCRYPTION_KEY`).
2. `docker compose up --build` — backend applies Prisma migrations on start.
3. Open http://localhost:8080 and log in with GitHub or GitLab.
4. Sync repositories from the connections page.
5. Add an LLM config (base URL, API key, model) and click **Test connection**.
6. Pick a repository and submit a new prompt/task.
7. Watch the live console (SSE) and the proposed diff.
8. Approve/let the worker finish, then confirm the branch and pull request
   appear on the git host.

> Note: the live OAuth login, LLM calls, and branch/PR creation paths could
> not be exercised without real provider and LLM credentials — verify them
> with the checklist above.
