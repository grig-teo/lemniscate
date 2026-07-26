//! Lemniscate Agent — Tauri shell: pairing window, system tray with status,
//! and the device tunnel lifecycle. Rust core lives in protocol/config/
//! tunnel/commands modules.

mod commands;
mod config;
mod protocol;
mod tunnel;

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tokio::process::Command;

use config::Config;
use protocol::Meta;

const STATUS_EVENT: &str = "agent-status";

#[derive(Default)]
struct StatusInfo {
    status: String,
    detail: Option<String>,
}

/// Shared app state: latest status, saved pairing, tray handles, tunnel task.
#[derive(Default)]
pub struct AppState {
    status: Mutex<StatusInfo>,
    config: Mutex<Option<Config>>,
    status_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    // Kept alive for the app's lifetime — dropping a TrayIcon removes it.
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
    tunnel: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateView {
    status: String,
    detail: Option<String>,
    paired: bool,
    server: Option<String>,
    device_name: Option<String>,
}

// --- status / tray ----------------------------------------------------------

/// Update the status everywhere: in-memory state, tray item, WebView event.
pub(crate) fn set_status(app: &AppHandle, status: &str, detail: Option<&str>) {
    {
        let state = app.state::<AppState>();
        let mut info = state.status.lock().unwrap();
        info.status = status.to_string();
        info.detail = detail.map(str::to_string);
    }
    update_tray_status(app, status);
    let _ = app.emit(STATUS_EVENT, json!({ "status": status, "detail": detail }));
}

fn update_tray_status(app: &AppHandle, status: &str) {
    let state = app.state::<AppState>();
    let item = state.status_item.lock().unwrap();
    if let Some(item) = item.as_ref() {
        let _ = item.set_text(format!("Status: {status}"));
    }
}

pub(crate) fn clear_saved_config(app: &AppHandle) {
    *app.state::<AppState>().config.lock().unwrap() = None;
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let status_item = MenuItem::with_id(app, "status", "Status: starting", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Lemniscate Agent", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status_item, &quit])?;
    let tray = TrayIconBuilder::new()
        .icon(tray_icon(app))
        .menu(&menu)
        .tooltip("Lemniscate Agent")
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" {
                app.exit(0);
            }
        })
        .build(app)?;
    let state = app.state::<AppState>();
    *state.status_item.lock().unwrap() = Some(status_item);
    *state.tray.lock().unwrap() = Some(tray);
    Ok(())
}

/// Solid-color fallback tray icon (owned pixels → 'static). The bundled
/// window icon can't be reused here: default_window_icon() borrows the app.
fn tray_icon(_app: &AppHandle) -> tauri::image::Image<'static> {
    let rgba = vec![76u8, 110, 245, 255].repeat(32 * 32);
    tauri::image::Image::new_owned(rgba, 32, 32)
}

// --- tunnel lifecycle ----------------------------------------------------------

pub(crate) fn start_tunnel(app: &AppHandle, config: Config, meta: Meta) {
    let state = app.state::<AppState>();
    if let Some(handle) = state.tunnel.lock().unwrap().take() {
        handle.abort();
    }
    let app_handle = app.clone();
    let handle = tauri::async_runtime::spawn(tunnel::run(app_handle, config, meta));
    *state.tunnel.lock().unwrap() = Some(handle);
}

/// On launch, reconnect with the saved credentials when they exist.
fn maybe_resume_tunnel(app: &AppHandle) {
    let Some(saved) = config::load(&config::config_path()) else {
        set_status(app, "disconnected", Some("not paired"));
        return;
    };
    *app.state::<AppState>().config.lock().unwrap() = Some(saved.clone());
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let meta = collect_meta().await;
        start_tunnel(&app_handle, saved, meta);
    });
}

// --- pairing -------------------------------------------------------------------

#[tauri::command]
fn get_state(state: State<AppState>) -> StateView {
    let info = state.status.lock().unwrap();
    let saved = state.config.lock().unwrap();
    StateView {
        status: info.status.clone(),
        detail: info.detail.clone(),
        paired: saved.is_some(),
        server: saved.as_ref().map(|c| c.server.clone()),
        device_name: saved.as_ref().map(|c| c.name.clone()),
    }
}

#[tauri::command]
async fn pair(
    app: AppHandle,
    state: State<'_, AppState>,
    server: String,
    code: String,
    name: Option<String>,
) -> Result<Value, String> {
    set_status(&app, "pairing", None);
    let meta = collect_meta().await;
    let name = name.filter(|n| !n.is_empty()).unwrap_or_else(|| meta.hostname.clone());
    let claimed = claim_device(&server, &code, &name, &meta).await.inspect_err(|e| {
        set_status(&app, "error", Some(e));
    })?;
    config::save(&claimed, &config::config_path()).map_err(|e| format!("cannot save config: {e}"))?;
    *state.config.lock().unwrap() = Some(claimed.clone());
    let _ = app.autolaunch().enable(); // best-effort
    start_tunnel(&app, claimed.clone(), meta);
    Ok(json!({ "deviceId": claimed.device_id, "name": claimed.name }))
}

/// Unpair: stop the tunnel, wipe the saved credentials, back to the form.
#[tauri::command]
fn unpair(app: AppHandle, state: State<'_, AppState>) {
    if let Some(handle) = state.tunnel.lock().unwrap().take() {
        handle.abort();
    }
    config::clear(&config::config_path());
    *state.config.lock().unwrap() = None;
    set_status(&app, "disconnected", Some("not paired"));
}

/// POST /api/devices/claim — mirrors claimPairingCode in agent/index.js.
async fn claim_device(server: &str, code: &str, name: &str, meta: &Meta) -> Result<Config, String> {
    let base = server.trim_end_matches('/');
    let response = reqwest::Client::new()
        .post(format!("{base}/api/devices/claim"))
        .json(&json!({ "code": code, "name": name, "platform": "desktop", "meta": meta }))
        .send()
        .await
        .map_err(|e| format!("claim request failed: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("Pairing code not recognized — generate a new one in the web UI.".into());
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Pairing code expired — generate a new one in the web UI.".into());
    }
    if !status.is_success() {
        return Err(format!("Claim failed (HTTP {status})"));
    }
    parse_claim_response(base, response).await
}

async fn parse_claim_response(base: &str, response: reqwest::Response) -> Result<Config, String> {
    let body: Value = response.json().await.map_err(|e| format!("bad claim response: {e}"))?;
    let device_id = body.get("deviceId").and_then(Value::as_str).unwrap_or_default();
    let device_token = body.get("deviceToken").and_then(Value::as_str).unwrap_or_default();
    if device_id.is_empty() || device_token.is_empty() {
        return Err("Claim response is missing deviceId/deviceToken".into());
    }
    let name = body.get("name").and_then(Value::as_str).unwrap_or("desktop");
    Ok(Config {
        server: base.to_string(),
        device_id: device_id.to_string(),
        device_token: device_token.to_string(),
        name: name.to_string(),
        platform: "desktop".into(),
    })
}

// --- meta ------------------------------------------------------------------------

/// meta object sent in the claim body and the WS hello (Node-compatible names).
async fn collect_meta() -> Meta {
    Meta {
        os: node_os().to_string(),
        arch: node_arch().to_string(),
        hostname: hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_else(|| "unknown".into()),
        agent_version: protocol::AGENT_VERSION.into(),
        docker_available: docker_available().await,
    }
}

fn node_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

async fn docker_available() -> bool {
    // Docker Desktop can wedge — never let the probe hang the pairing flow.
    let probe = Command::new("docker").arg("info").output();
    match tokio::time::timeout(std::time::Duration::from_secs(5), probe).await {
        Ok(Ok(output)) => output.status.success(),
        _ => false,
    }
}

// --- entry -------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![])))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![get_state, pair, unpair])
        .setup(|app| {
            build_tray(app.handle())?;
            maybe_resume_tunnel(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Lemniscate Agent");
}
