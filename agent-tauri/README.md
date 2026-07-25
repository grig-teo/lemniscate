# Lemniscate Agent (Tauri)

Cross-platform **desktop agent** for Lemniscate — a native rewrite-in-progress
of the Node agent in [`../agent`](../agent). It pairs with your Lemniscate
server (one-time, via a 6-char code from the web UI), keeps an **outbound**
WebSocket tunnel open, and executes commands pushed from the web UI. No Node
runtime required on the device; no inbound ports or firewall changes.

Targets: **Linux, macOS, Windows** (Tauri v2).

## Status vs the Node agent

| Area | Node agent (`agent/`) | This app |
| --- | --- | --- |
| Pairing (`POST /api/devices/claim`) | yes | yes (pairing window) |
| WS tunnel: hello / 25s heartbeat / backoff 1s→30s | yes | yes |
| Close 4001 → re-pair | exit(1) | clears saved config, surfaces error in UI |
| Config persistence (0600 on unix) | `~/.lemniscate-agent.json` | `<config-dir>/lemniscate-agent/config.json` |
| `run_web` (clone/pull → compose or Dockerfile → wait → open browser) | yes | **yes (full parity)** |
| `install_apk` | yes | stub: replies `failed` ("not yet supported") |
| `build_android` | yes | stub: replies `failed` ("not yet supported") |
| `run_desktop` | yes | stub: replies `failed` ("not yet supported") |

The wire protocol (`protocol.rs`) mirrors `agent/lib.js` message shapes and is
unit-tested against the same cases as `agent/lib.test.js`.

## Layout

```
agent-tauri/
├── index.html, src/          # minimal vanilla-TS pairing window (Vite)
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json       # "Lemniscate Agent", single 420x520 window
    ├── capabilities/         # default window permissions
    └── src/
        ├── protocol.rs       # serde message types, WS URL, repo-dir naming (unit-tested)
        ├── config.rs         # pairing config load/save, 0600 on unix (unit-tested)
        ├── tunnel.rs         # WS loop: hello, heartbeat, backoff reconnect, 4001 → re-pair
        ├── commands.rs       # command dispatch; run_web fully implemented
        ├── lib.rs            # Tauri setup: tray, status events, pairing command, autostart
        └── main.rs           # thin entry point
```

## Dev setup

Prerequisites: [rustup](https://rustup.rs) (stable), Node 22, and on Linux the
Tauri system deps (`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev
patchelf` — see the CI workflow).

```sh
cd agent-tauri
npm install
npm run tauri dev        # hot-reloads the UI, recompiles Rust on change
```

Other useful commands:

```sh
npm run build            # typecheck + build the frontend only
cd src-tauri && cargo test    # protocol/config unit tests
npm run tauri build      # release build + platform installers (bundles in
                         # src-tauri/target/release/bundle/)
```

## Usage

1. Build/run the app, then in the web UI generate a device pairing code.
2. In the agent window enter the server URL, the 6-char code and a device
   name → **Pair & connect**.
3. The app saves credentials (mode `0600` on unix), enables autostart, and
   keeps the tunnel alive in the background. The system tray shows the current
   status and has a Quit item; the window can be closed.
4. If the server rejects the token (close code 4001) the saved config is
   cleared and the UI asks you to pair again.

## CI

`.github/workflows/agent-tauri-build.yml` builds on pushes touching
`agent-tauri/**`: matrix of `macos-latest` / `windows-latest` /
`ubuntu-latest`, running `cargo test`, `cargo build --release` and
`npm run tauri build`, uploading the bundles as artifacts.

## Notes & roadmap

- **Icons**: `tauri.conf.json` ships with an empty `bundle.icon` list so the
  default Tauri icons are used. Run `npm run tauri icon <source.png>` to add
  real branding later.
- **Port the remaining commands** from the Node agent: `install_apk`
  (download ≤100MB with same-origin `Device` token), `build_android` (docker
  gradle build box + artifact upload), `run_desktop` (npm install + detached
  start script).
- **Tray status** currently mirrors connect/disconnect; command progress
  events can be added the same way.
- **Mobile**: Tauri v2 supports iOS/Android targets — the long-term plan is to
  share this Rust core with mobile builds, replacing the Termux setup.
