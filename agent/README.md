# Lemniscate device agent

A small companion CLI that runs on your local machine, connects **outbound**
over a WebSocket to your Lemniscate server, and executes commands pushed from
the web UI — `run_web`, which clones a repository and runs it in your local
Docker so the app is reachable at `http://127.0.0.1:<port>`; `run_desktop`,
which launches a Node desktop app (Tauri/Electron); `build_android`, which
builds an APK in Docker and uploads it as an artifact; `install_apk`, which
sideloads an APK via adb when a device is attached; and `run_ios`, which
builds and launches an iOS app in the Simulator.

## Requirements

- Node.js >= 22
- `git` on PATH
- Docker (`docker` + `docker compose`) for `run_web` and `build_android`
- adb for `install_apk` on a desktop — either on PATH, at
  `$ANDROID_HOME/platform-tools/adb`, or at
  `~/Library/Android/sdk/platform-tools/adb`
- macOS with Xcode (`xcodebuild`, `xcrun simctl`, `xcrun devicectl`) for
  `run_ios`; `xcodegen` is optional (used when the repo ships a
  `project.yml`)
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

## What install_apk does

1. If adb is available (PATH, `$ANDROID_HOME/platform-tools/adb`, or
   `~/Library/Android/sdk/platform-tools/adb`) and `adb devices -l` lists at
   least one device/emulator, the APK — downloaded from the artifact URL, or
   the local `apkPath` handed over from a `build_android` chain — is installed
   with `adb install -r`; the result reports the target serial (e.g.
   `emulator-5554`) as `installedTo` with `method: 'adb'`.
   `payload.deviceSerial` selects the adb target; an unknown serial fails the
   command with a message listing the attached serials.
2. Otherwise the previous behavior applies unchanged: the APK is saved under
   `~/.lemniscate-agent/apks/` and, on Termux, an install intent is fired
   (`am start` VIEW, falling back to `termux-open`)

## What run_ios does

macOS only — any other platform fails with a clear error result.

1. Clones (or fetches + hard-resets) the repo, same as `run_web`
2. If `ios/project.yml` (or a root `project.yml`) exists and `xcodegen` is on
   PATH, regenerates the project with `xcodegen`
3. Locates the Xcode project: `ios/` first, then the repo root, then any other
   one-level-deep directory; a `.xcworkspace` wins over a `.xcodeproj`. The
   scheme is `payload.scheme`, else the project basename
4. Picks the destination: `payload.destination` when given, else a booted
   simulator, else the first available iPhone simulator is booted
5. Builds with `xcodebuild -scheme <scheme> -destination
   'platform=iOS Simulator,id=<udid>' -derivedDataPath <repo>/dd build`
6. Installs and launches the produced `.app` (found under
   `dd/Build/Products/*-iphonesimulator/`) with `xcrun simctl install` /
   `xcrun simctl launch <udid> <bundle-id>`; the bundle id is read from the
   app's Info.plist via PlistBuddy
7. When `payload.destination` is a physical-device UDID the app is built for
   the device and installed with `xcrun devicectl device install app
   --device <udid>` instead (best-effort — provisioning is on the user)

Concise progress lines are streamed as `running` command results; on failure
the result carries the error plus the tail of the build log.

## Tests

```sh
npm test   # node --test, no extra frameworks
```
