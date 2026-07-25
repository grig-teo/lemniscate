# Lemniscate — standalone LOCAL install

A fully separate Lemniscate instance on your own machine: its own database,
its own login, its own devices. Machines and phones on the same Wi-Fi can
pair with it over LAN. It coexists with a cloud deploy — the compose project
is named `lemniscate-local`, so containers and volumes never clash.

## Requirements

- Docker with the Compose plugin (`docker compose version`), running.
- git, curl, openssl (preinstalled on macOS and most Linux distros).

## Install (or upgrade)

```sh
bash scripts/install-local.sh
```

The installer checks Docker, clones (or `git pull`-updates) the repo into
`~/.lemniscate-local`, creates `deploy/local/.env` with generated secrets on
first run, asks for the public URL (default: your LAN IP, so phones can reach
it), then builds and starts the stack and waits for the UI to answer.
Re-running the same command upgrades in place — configuration and data are
kept.

## What works locally

Everything. LLM configs and git-host connections are created in the UI
(Settings) — personal access tokens work with every provider, so no OAuth
apps are needed (you can still set `GITHUB_CLIENT_ID` etc. in
`deploy/local/.env` for one-click OAuth login). A local LLM (e.g. Ollama)
works too: `ALLOW_PRIVATE_URLS=true` is the default here.

## LAN pairing

Devices pair against the URL you opened the UI on (the pairing dialog shows
the exact command). Open the UI via `http://<your-LAN-IP>:8280` — set as
`PUBLIC_URL` in `deploy/local/.env` — so phones on the same Wi-Fi can reach
this machine. Only the frontend port (8280) is exposed; the frontend nginx
proxies `/api` (including the device WebSocket tunnel) to the backend, which
stays internal together with Postgres, Redis and MinIO.

## Data

All state lives in Docker named volumes of the `lemniscate-local` project
(`lemniscate-local_pgdata`, `_redisdata`, `_miniodata`, `_agentworkdir`).

## Uninstall

```sh
cd ~/.lemniscate-local
docker compose --env-file deploy/local/.env -f deploy/local/docker-compose.yml down -v
rm -rf ~/.lemniscate-local
```

`down -v` deletes the volumes — all local data is gone after this.
