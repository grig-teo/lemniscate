# Lemniscate device agent

A small companion CLI that runs on your local machine, connects **outbound**
over a WebSocket to your Lemniscate server, and executes commands pushed from
the web UI — currently `run_web`, which clones a repository and runs it in
your local Docker so the app is reachable at `http://127.0.0.1:<port>`.

## Requirements

- Node.js >= 22
- `git` on PATH
- Docker (`docker` + `docker compose`) for `run_web` commands
- No inbound ports or firewall changes needed — the agent only dials out

## Install

```sh
cd agent
npm install
```

## Pair (one-time)

In the Lemniscate web UI, create a pairing code, then:

```sh
node index.js --server https://lemniscate.example.com --pair ABC123 --name "My Mac"
```

The agent claims the code, saves `{server, deviceId, deviceToken, name,
platform}` to `~/.lemniscate-agent.json` (mode `0600`) and connects. `--name`
defaults to your hostname, `--platform` defaults to `desktop`. The server URL
can also come from the `LEMNISCATE_SERVER` env var.

## Run

After pairing, just:

```sh
node index.js
```

It loads the saved credentials and reconnects. On connection loss it retries
with exponential backoff (1s doubling up to a 30s cap) forever. If the server
rejects the token (close code 4001) the agent exits — pair again with a new
code. Heartbeats are sent every 25s so the server can show the device online.

## What run_web does

1. Clones (or fetches + hard-resets) the repo into
   `~/.lemniscate-agent/repos/<slug>-<hash>/`
2. Uses the given `composePath`, else the first of `docker-compose.yml`,
   `docker-compose.yaml`, `compose.yml`, `compose.yaml` → `docker compose up
   -d --build`; with no compose file but a root `Dockerfile` → `docker build`
   + `docker run -d -p <port>:<port>`
3. Waits up to 30s for `http://127.0.0.1:<port>` to respond, then tries to
   open your browser (`open` / `xdg-open` / `cmd /c start`, best-effort)
4. Reports `done` (with URL + project dir) or `failed` (with the error and
   the last ~2KB of the build log) back to the server

Commands run one at a time, queued in arrival order.

## Tests

```sh
npm test   # node --test, no extra frameworks
```
