//! `run_desktop`: clone/pull, pick the npm start script, npm install, spawn
//! the GUI app detached, give it a grace period to prove it stays up.
//! Parity with executeRunDesktop in agent/index.js.

use serde_json::{json, Map, Value};
use std::path::Path;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::exec::{self, CommandContext, ResultSender};

const NPM_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const CARGO_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const START_GRACE: Duration = Duration::from_secs(20);
const ALIVE_POLL: Duration = Duration::from_millis(500);

/// package.json scripts tried as the desktop entry point, in priority order.
const DESKTOP_SCRIPT_CANDIDATES: [&str; 4] = ["tauri", "electron", "dev", "start"];

pub async fn execute(tx: ResultSender, config: Config, id: String, payload: Value) {
    let mut ctx = CommandContext::new(tx, id);
    ctx.running().await;
    match attempt(&mut ctx, &payload).await {
        Ok(result) => ctx.done(result).await,
        Err(error) => ctx.fail_with_log(error, &config.server, &config.device_token).await,
    }
}

async fn attempt(ctx: &mut CommandContext, payload: &Value) -> Result<Value, String> {
    let repo_url = exec::required_str(payload, "repoUrl", "run_desktop")?;
    let branch = exec::required_str(payload, "branch", "run_desktop")?;
    let project_dir = exec::ensure_repo(ctx, &repo_url, &branch).await?;
    let scripts = desktop_project_scripts(&project_dir)?;
    let requested = payload.get("startScript").and_then(Value::as_str);
    let script = require_desktop_script(&scripts, requested)?;
    ensure_cargo_for_tauri(ctx, &script).await?;
    ctx.step("npm", &["install"], Some(&project_dir), NPM_INSTALL_TIMEOUT).await?;
    let mut child = spawn_desktop_app(ctx, &project_dir, &script)?;
    let pid = child.id();
    if !wait_for_process_alive(&mut child).await {
        return Err(format!("npm run {script} exited during startup — check the project log on the device"));
    }
    Ok(json!({
        "script": script,
        "projectDir": project_dir,
        "pid": pid,
        "note": "The app window should open on the desktop shortly",
    }))
}

/// package.json scripts of the cloned repo; Err when not a Node project.
fn desktop_project_scripts(project_dir: &Path) -> Result<Map<String, Value>, String> {
    let package_json = project_dir.join("package.json");
    if !package_json.exists() {
        return Err("not a Node desktop project (no package.json at repo root)".to_string());
    }
    let text = std::fs::read_to_string(&package_json).map_err(|e| format!("cannot read package.json: {e}"))?;
    let parsed: Value = serde_json::from_str(&text).map_err(|e| format!("cannot parse package.json: {e}"))?;
    Ok(parsed.get("scripts").and_then(Value::as_object).cloned().unwrap_or_default())
}

/// Resolve the start script or Err with a message naming what went wrong.
fn require_desktop_script(scripts: &Map<String, Value>, requested: Option<&str>) -> Result<String, String> {
    if let Some(script) = pick_desktop_script(scripts, requested) {
        return Ok(script);
    }
    if let Some(requested) = requested {
        return Err(format!("start script '{requested}' not found in package.json"));
    }
    Err(format!(
        "no desktop start script in package.json (looked for: {})",
        DESKTOP_SCRIPT_CANDIDATES.join(", ")
    ))
}

/// Tauri compiles Rust on first run — fail fast when cargo is missing.
async fn ensure_cargo_for_tauri(ctx: &mut CommandContext, script: &str) -> Result<(), String> {
    if !script.contains("tauri") {
        return Ok(());
    }
    let cargo = exec::run_capture("cargo", &["--version"], None, CARGO_PROBE_TIMEOUT).await;
    ctx.append(&format!("$ cargo --version\n{}", cargo.output));
    if !cargo.ok {
        return Err(format!("'{script}' needs the Rust toolchain — install it via https://rustup.rs on this device"));
    }
    Ok(())
}

/// Launch the GUI app detached so it outlives this command. Dropping the
/// returned Child does not kill the process.
fn spawn_desktop_app(ctx: &mut CommandContext, project_dir: &Path, script: &str) -> Result<Child, String> {
    let child = std::process::Command::new("npm")
        .args(["run", script])
        .current_dir(project_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn npm: {e}"))?;
    ctx.append(&format!("$ npm run {script} (detached, pid {})", child.id()));
    Ok(child)
}

/// Give the app a grace period to prove it stays up (didn't crash at startup).
async fn wait_for_process_alive(child: &mut Child) -> bool {
    let deadline = Instant::now() + START_GRACE;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(None) => tokio::time::sleep(ALIVE_POLL).await,
            _ => return false, // exited already, or the state is unreadable
        }
    }
    true
}

/// Which npm script to launch: a requested script wins but must exist;
/// otherwise the first candidate present. None when nothing usable was found.
fn pick_desktop_script(scripts: &Map<String, Value>, requested: Option<&str>) -> Option<String> {
    if let Some(requested) = requested {
        return scripts.contains_key(requested).then(|| requested.to_string());
    }
    DESKTOP_SCRIPT_CANDIDATES
        .iter()
        .find(|candidate| scripts.contains_key(**candidate))
        .map(|candidate| candidate.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scripts(names: &[&str]) -> Map<String, Value> {
        names.iter().map(|name| (name.to_string(), json!("cmd"))).collect()
    }

    #[test]
    fn pick_desktop_script_prefers_candidates_in_priority_order() {
        assert_eq!(pick_desktop_script(&scripts(&["start", "dev", "tauri"]), None), Some("tauri".to_string()));
        assert_eq!(pick_desktop_script(&scripts(&["start", "electron"]), None), Some("electron".to_string()));
    }

    #[test]
    fn pick_desktop_script_honors_the_requested_script_when_it_exists() {
        let scripts = scripts(&["start", "custom"]);
        assert_eq!(pick_desktop_script(&scripts, Some("custom")), Some("custom".to_string()));
    }

    #[test]
    fn pick_desktop_script_is_none_for_a_missing_requested_script() {
        let scripts = scripts(&["start"]);
        assert_eq!(pick_desktop_script(&scripts, Some("custom")), None);
    }

    #[test]
    fn pick_desktop_script_is_none_when_no_candidate_exists() {
        assert_eq!(pick_desktop_script(&scripts(&["build"]), None), None);
    }

    #[test]
    fn require_desktop_script_names_what_went_wrong() {
        let scripts = scripts(&["build"]);
        let err = require_desktop_script(&scripts, Some("nope")).expect_err("missing requested");
        assert_eq!(err, "start script 'nope' not found in package.json");
        let err = require_desktop_script(&scripts, None).expect_err("no candidate");
        assert_eq!(err, "no desktop start script in package.json (looked for: tauri, electron, dev, start)");
    }
}
