//! Shared command-execution plumbing: the command_result envelope with a
//! per-command log (mirrors the `log`/`step` pattern in agent/index.js),
//! process spawning with a timeout, and the git clone/pull helper every
//! repo-based command uses.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::protocol::{self, ClientMessage};

/// Node's execFile default timeout (agent/index.js `run`).
pub const DEFAULT_CMD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Inline log tail size in the `failed` result (bytes).
pub const LOG_TAIL_BYTES: usize = 2048;

/// Logs larger than this are uploaded as a `.log` artifact; smaller ones
/// stay inline (the tail IS the full log). Single source of truth for both
/// the Node agent (lib.js) and this Tauri agent.
pub const LOG_UPLOAD_THRESHOLD_BYTES: usize = 8192;

pub type ResultSender = mpsc::Sender<ClientMessage>;

/// Outcome of a spawned process; never errors — the failure is in the value
/// (mirrors `run` in agent/index.js).
pub struct CmdOutput {
    pub ok: bool,
    pub code: Option<i32>,
    pub output: String,
}

/// Per-command state: the result channel, the command id, and the accumulated
/// step log that is sent back as `log` on failure.
pub struct CommandContext {
    tx: ResultSender,
    id: String,
    log: String,
}

impl CommandContext {
    pub fn new(tx: ResultSender, id: String) -> Self {
        Self { tx, id, log: String::new() }
    }

    pub async fn running(&self) {
        self.send("running", None).await;
    }

    /// Stream progress: appended to the log AND sent as running+{progress}.
    pub async fn progress(&mut self, text: &str) {
        self.append(text);
        self.send("running", Some(json!({ "progress": text }))).await;
    }

    pub async fn done(&self, result: Value) {
        self.send("done", Some(result)).await;
    }

    pub async fn fail(&self, error: String) {
        let log = protocol::tail_log(&self.log, LOG_TAIL_BYTES);
        self.send("failed", Some(json!({ "error": error, "log": log }))).await;
    }

    /// Like `fail` but uploads the full log as a `.log` artifact when it
    /// exceeds LOG_UPLOAD_THRESHOLD_BYTES, adding `logArtifactUrl` to the
    /// result. Falls back gracefully to tail-only on quota/network failure.
    pub async fn fail_with_log(&self, error: String, server: &str, device_token: &str) {
        let tail = protocol::tail_log(&self.log, LOG_TAIL_BYTES);
        let mut result = json!({ "error": error, "log": tail });
        if self.log.len() > LOG_UPLOAD_THRESHOLD_BYTES {
            if let Some(url) = upload_log_artifact(server, device_token, &self.id, &self.log).await {
                result["logArtifactUrl"] = json!(url);
            }
        }
        self.send("failed", Some(result)).await;
    }

    pub fn append(&mut self, line: &str) {
        self.log.push_str(line);
        self.log.push('\n');
    }

    /// Run a step, appending `$ cmd args` + output to the log; Err on failure.
    pub async fn step(
        &mut self,
        program: &str,
        args: &[&str],
        cwd: Option<&Path>,
        timeout: Duration,
    ) -> Result<String, String> {
        let result = run_capture(program, args, cwd, timeout).await;
        self.append(&format!("$ {} {}\n{}", program, args.join(" "), result.output));
        if !result.ok {
            let first = args.first().copied().unwrap_or("");
            let code = result.code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
            return Err(format!("{program} {first} failed (exit {code})"));
        }
        Ok(result.output)
    }

    async fn send(&self, status: &str, result: Option<Value>) {
        let _ = self.tx.send(protocol::command_result_message(&self.id, status, result)).await;
    }
}

/// Spawn a process, capture stdout+stderr, kill it when the timeout hits.
pub async fn run_capture(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
) -> CmdOutput {
    let mut command = Command::new(program);
    command.args(args).kill_on_drop(true);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(out)) => cmd_output(out),
        Ok(Err(e)) => failed_output(format!("failed to spawn {program}: {e}")),
        Err(_) => failed_output(format!("{program} timed out after {}s", timeout.as_secs())),
    }
}

fn cmd_output(out: std::process::Output) -> CmdOutput {
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    CmdOutput { ok: out.status.success(), code: out.status.code(), output }
}

fn failed_output(message: String) -> CmdOutput {
    CmdOutput { ok: false, code: None, output: message }
}

// --- repo checkout -----------------------------------------------------------

pub fn repos_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".lemniscate-agent")
        .join("repos")
}

pub fn repo_dir_for(repo_url: &str) -> PathBuf {
    repos_root().join(protocol::repo_dir_name(repo_url))
}

/// Clone (or fetch + hard-reset) the repo into the repos dir.
pub async fn ensure_repo(
    ctx: &mut CommandContext,
    repo_url: &str,
    branch: &str,
) -> Result<PathBuf, String> {
    let dir = repo_dir_for(repo_url);
    let dir_str = dir.to_string_lossy().into_owned();
    if dir.join(".git").exists() {
        ctx.step("git", &["-C", &dir_str, "fetch", "--depth", "1", "origin", branch], None, DEFAULT_CMD_TIMEOUT).await?;
        ctx.step("git", &["-C", &dir_str, "reset", "--hard", "FETCH_HEAD"], None, DEFAULT_CMD_TIMEOUT).await?;
        return Ok(dir);
    }
    std::fs::create_dir_all(repos_root()).map_err(|e| format!("cannot create repos dir: {e}"))?;
    ctx.step("git", &["clone", "--depth", "1", "--branch", branch, repo_url, &dir_str], None, DEFAULT_CMD_TIMEOUT).await?;
    Ok(dir)
}

/// Required string payload field, with the Node agent's error wording.
pub fn required_str(payload: &Value, key: &str, command_type: &str) -> Result<String, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{command_type} payload is missing '{key}'"))
}

// --- artifact upload (shared by build_android and fail_with_log) ---------------

/// Upload endpoint for a built artifact on the Lemniscate server.
pub fn artifact_upload_url(upload_base: &str, filename: &str) -> String {
    format!(
        "{}/api/devices/artifacts?filename={}",
        upload_base.trim_end_matches('/'),
        protocol::percent_encode(filename)
    )
}

/// Backend-relative download path for a stored artifact key.
pub fn artifact_download_url(key: &str) -> String {
    format!("/api/devices/artifacts/{key}")
}

/// POST a raw artifact body to the server with device-token auth; returns
/// the stored key. Used by build_android (APKs) and fail_with_log (logs).
pub async fn post_artifact(
    upload_base: &str,
    filename: &str,
    body: &[u8],
    device_token: &str,
) -> Result<String, String> {
    let response = reqwest::Client::new()
        .post(artifact_upload_url(upload_base, filename))
        .header("content-type", "application/octet-stream")
        .header("authorization", format!("Device {device_token}"))
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| format!("artifact upload failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("artifact upload failed (HTTP {})", response.status()));
    }
    let parsed: Value = response.json().await.map_err(|e| format!("bad upload response: {e}"))?;
    parsed
        .get("key")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "upload response is missing 'key'".to_string())
}

/// Upload the full build/run log as a `.log` artifact; returns the download
/// URL or None on failure (quota exhausted, network error, bad response).
pub async fn upload_log_artifact(
    server: &str,
    device_token: &str,
    command_id: &str,
    log: &str,
) -> Option<String> {
    let filename = format!("{command_id}-{}.log", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0));
    let body = log.as_bytes();
    let key = post_artifact(server, &filename, body, device_token).await.ok()?;
    Some(artifact_download_url(&key))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn recv_value(rx: &mut mpsc::Receiver<ClientMessage>) -> Value {
        serde_json::to_value(rx.recv().await.expect("a frame")).expect("serializes")
    }

    #[tokio::test]
    async fn progress_streams_running_with_result_and_logs() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut ctx = CommandContext::new(tx, "c1".into());
        ctx.running().await;
        ctx.progress("Repository ready").await;
        assert_eq!(
            recv_value(&mut rx).await,
            json!({"type": "command_result", "id": "c1", "status": "running"})
        );
        assert_eq!(
            recv_value(&mut rx).await,
            json!({"type": "command_result", "id": "c1", "status": "running",
                   "result": {"progress": "Repository ready"}})
        );
    }

    #[tokio::test]
    async fn fail_includes_the_error_and_the_log_tail() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut ctx = CommandContext::new(tx, "c2".into());
        ctx.append("some step output");
        ctx.fail("boom".into()).await;
        assert_eq!(
            recv_value(&mut rx).await,
            json!({"type": "command_result", "id": "c2", "status": "failed",
                   "result": {"error": "boom", "log": "some step output\n"}})
        );
    }

    #[tokio::test]
    async fn fail_with_log_skips_upload_when_log_is_below_threshold() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut ctx = CommandContext::new(tx, "c5".into());
        ctx.append("short output");
        ctx.fail_with_log("err".into(), "https://x.space", "tok").await;
        let frame = recv_value(&mut rx).await;
        assert_eq!(frame["status"], "failed");
        assert_eq!(frame["result"]["error"], "err");
        assert!(frame["result"]["log"].as_str().unwrap().contains("short output"));
        // No upload attempted → no logArtifactUrl.
        assert!(frame["result"].get("logArtifactUrl").is_none());
    }

    #[test]
    fn artifact_upload_url_appends_encoded_filename_query() {
        assert_eq!(
            artifact_upload_url("https://x.space/", "my app.apk"),
            "https://x.space/api/devices/artifacts?filename=my%20app.apk"
        );
    }

    #[test]
    fn artifact_download_url_builds_backend_relative_path() {
        assert_eq!(
            artifact_download_url("dev-1/abc-app.apk"),
            "/api/devices/artifacts/dev-1/abc-app.apk"
        );
    }

    #[tokio::test]
    async fn step_records_the_command_and_its_output() {
        let (tx, _rx) = mpsc::channel(4);
        let mut ctx = CommandContext::new(tx, "c3".into());
        let out = ctx
            .step("echo", &["hi"], None, Duration::from_secs(5))
            .await
            .expect("echo succeeds");
        assert_eq!(out.trim(), "hi");
        ctx.fail("x".into()).await;
        // The failure frame carries the log tail with the echo line.
    }

    #[tokio::test]
    async fn step_errors_with_exit_code_on_failure() {
        let (tx, _rx) = mpsc::channel(4);
        let mut ctx = CommandContext::new(tx, "c4".into());
        let err = ctx
            .step("false", &[], None, Duration::from_secs(5))
            .await
            .expect_err("false fails");
        assert_eq!(err, "false  failed (exit 1)");
    }

    #[test]
    fn required_str_names_the_command_and_key() {
        let err = required_str(&json!({}), "port", "run_web").expect_err("missing");
        assert_eq!(err, "run_web payload is missing 'port'");
        assert_eq!(required_str(&json!({"branch": "main"}), "branch", "run_ios").unwrap(), "main");
    }
}

// --- docker binary resolution ---------------------------------------------------

use std::sync::OnceLock;

static DOCKER_PATH: OnceLock<Option<String>> = OnceLock::new();

/// Candidate docker binaries: PATH first, then the standard install
/// locations. GUI-launched agents get a minimal PATH without /usr/local/bin
/// or homebrew, so bare "docker" is often ENOENT there.
pub fn docker_candidates() -> Vec<&'static str> {
    if cfg!(target_os = "macos") {
        vec!["docker", "/usr/local/bin/docker", "/opt/homebrew/bin/docker"]
    } else if cfg!(target_os = "linux") {
        vec!["docker", "/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker"]
    } else if cfg!(target_os = "windows") {
        vec!["docker", "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"]
    } else {
        vec!["docker"]
    }
}

/// First docker binary that answers `docker info`; cached for the process.
pub async fn find_docker() -> Option<String> {
    if let Some(cached) = DOCKER_PATH.get() {
        return cached.clone();
    }
    for candidate in docker_candidates() {
        if run_capture(candidate, &["info"], None, Duration::from_secs(5)).await.ok {
            let found = Some(candidate.to_string());
            let _ = DOCKER_PATH.set(found.clone());
            return found;
        }
    }
    let _ = DOCKER_PATH.set(None);
    None
}

/// Resolved docker binary, or an error for commands that need it.
pub async fn require_docker() -> Result<String, String> {
    find_docker()
        .await
        .ok_or_else(|| "Docker not found or not running — start Docker on this device".to_string())
}

#[cfg(test)]
mod docker_tests {
    use super::*;

    #[test]
    fn docker_candidates_starts_with_path_docker() {
        let candidates = docker_candidates();
        assert_eq!(candidates[0], "docker");
        if cfg!(target_os = "macos") {
            assert!(candidates.contains(&"/usr/local/bin/docker"));
            assert!(candidates.contains(&"/opt/homebrew/bin/docker"));
        }
    }
}
