# Lemniscate Connect (Tauri)

Cross-platform **desktop app** for Lemniscate (formerly "Lemniscate Agent") — a native rewrite-in-progress
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
| `install_apk` (adb preferred: PATH → `$ANDROID_HOME` → `~/Library/Android/sdk`; `adb -s <serial> install -r`; else download ≤100MB with same-origin `Device` token + Termux intent) | yes | **yes (full parity)** |
| `build_android` (docker gradle build box → newest APK → artifact upload) | yes | **yes (full parity)** |
| `run_desktop` (npm install → detached start script → 20s alive grace) | yes | **yes (full parity)** |
| `run_ios` (xcodegen → sim/device destination → xcodebuild → simctl/devicectl, progress frames) | yes | **yes (full parity, macOS only)** |

The wire protocol (`protocol.rs`) shares a single contract-fixture suite with
the Node agent and the backend — `tests/contract/device-ws/`. The Rust tests
embed those JSON files via `include_str!` and round-trip every frame, so a
wire-format change in one consumer fails all three unless the shared fixture
is updated in the same commit.

## Layout

```
agent-tauri/
├── index.html, src/          # minimal vanilla-TS pairing window (Vite)
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json       # "Lemniscate Connect", single 420x520 window
    ├── capabilities/         # default window permissions
    └── src/
        ├── protocol.rs       # serde message types, WS URL, repo-dir naming (unit-tested)
        ├── config.rs         # pairing config load/save, 0600 on unix (unit-tested)
        ├── tunnel.rs         # WS loop: hello, heartbeat, backoff reconnect, 4001 → re-pair
        ├── commands.rs       # command dispatch to the executor modules
        ├── exec.rs           # shared plumbing: command_result envelope, step log,
        │                     # process spawn with timeout, git clone/pull (unit-tested)
        ├── run_web.rs        # run_web executor (compose/Dockerfile)
        ├── install_apk.rs    # install_apk executor (adb preferred, download fallback)
        ├── build_android.rs  # build_android executor (docker gradle + artifact upload)
        ├── run_desktop.rs    # run_desktop executor (npm install + detached start)
        ├── run_ios.rs        # run_ios executor (xcodebuild + simctl/devicectl)
        ├── xcode.rs          # pure Xcode/simctl helpers for run_ios (unit-tested)
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
- **Tray status** currently mirrors connect/disconnect; command progress
  events can be added the same way.
- **Mobile**: Tauri v2 supports iOS/Android targets — the long-term plan is to
  share this Rust core with mobile builds, replacing the Termux setup.
