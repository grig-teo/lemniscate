# Device WebSocket protocol fixtures

Canonical JSON snapshots of every frame type spoken over the device WS tunnel
(`GET /api/devices/ws?token=...`). They are decoded / re-encoded by contract
tests in **three** consumers, so any wire-format change must update exactly one
fixture file:

- **Backend** — `backend/tests/devices-ws.test.ts` (vitest)
- **Node agent** — `agent/lib.test.js` (node:test)
- **Tauri agent** — `agent-tauri/src-tauri/src/protocol.rs` (`#[cfg(test)]`,
  fixtures embedded via `include_str!`)

This mirrors the model already proven for the mobile API clients via
`../` (the `tasks-response.json` / `repositories-response.json` pair decoded by
the Android and iOS apps).

## Layout

Each file wraps the actual wire JSON in a `frame` key alongside a `_comment`
describing intent and a `direction` tag:

```json
{
  "_comment": "…what this frame means…",
  "direction": "client-to-server | server-to-client | close",
  "frame": { "type": "hello", "meta": { … } }
}
```

The `close-4001.json` fixture uses `closeCode` + `reason` instead of `frame`
(close codes are not JSON bodies).

`index.json` is the manifest — every consumer iterates it so an unlisted
fixture is invisible to CI, and `lint.js` enforces that the manifest matches the
directory contents.

| File | Direction | Covers |
| --- | --- | --- |
| `hello.json` | client→server | pairing hello with device metadata |
| `heartbeat.json` | client→server | 25 s keep-alive ping |
| `capabilities.json` | client→server | live run-target report (docker/adb/devicectl/simctl/emulator) |
| `command-result-running.json` | client→server | intermediate progress (status `running`) |
| `command-result-done.json` | client→server | successful completion (status `done`, with `result`) |
| `command-result-failed.json` | client→server | failure (status `failed`, with error/log `result`) |
| `welcome.json` | server→client | post-handshake greeting with `deviceId` |
| `command-run-web.json` | server→client | `run_web` envelope |
| `command-install-apk.json` | server→client | `install_apk` envelope |
| `command-build-android.json` | server→client | `build_android` envelope (enriched at dispatch) |
| `command-run-desktop.json` | server→client | `run_desktop` envelope |
| `command-run-ios.json` | server→client | `run_ios` envelope |
| `close-4001.json` | close | token-rejection close code (agent must re-pair) |

## Adding a new command type

1. Add the fixture `command-<type>.json` in this directory.
2. Append it to `index.json`.
3. Add the type string to `COMMAND_TYPES` in `agent/lib.js` **and**
   `agent-tauri/src-tauri/src/protocol.rs`.
4. Run `node tests/contract/device-ws/lint.js` — it must pass.

If any step is skipped the consumer tests (or the lint) go red in CI.
