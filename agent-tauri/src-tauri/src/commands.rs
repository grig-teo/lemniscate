//! Command execution: dispatch server-pushed commands to local processes.
//! `run_web` is fully implemented (parity with the Node agent);
//! `install_apk` / `build_android` / `run_desktop` report "not yet supported"
//! and each gets a dedicated executor function in a follow-up.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::protocol::{self, ClientMessage};

const HTTP_READY_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_POLL_INTERVAL: Duration = Duration::from_secs(1);
const COMPOSE_CANDIDATES: [&str; 4] = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
];

type ResultSender = mpsc::Sender<ClientMessage>;

/// Entry point from the tunnel read loop. `config` is unused by run_web but
/// threaded through for the upcoming download/upload commands (device token).
pub async fn execute(
    tx: ResultSender,
    _config: Config,
    id: String,
    command_type: String,
    payload: Value,
) {
    if command_type != "run_web" {
        let error = format!("'{command_type}' is not yet supported in the Tauri agent");
        send_result(&tx, &id, "failed", Some(json!({ "error": error }))).await;
        return;
    }
    send_result(&tx, &id, "running", None).await;
    match run_web(&payload).await {
        Ok(result) => send_result(&tx, &id, "done", Some(result)).await,
        Err(error) => send_result(&tx, &id, "failed", Some(json!({ "error": error }))).await,
    }
}

async fn send_result(tx: &ResultSender, id: &str, status: &str, result: Option<Value>) {
    let _ = tx.send(protocol::command_result_message(id, status, result)).await;
}

// --- run_web ---------------------------------------------------------------

async fn run_web(payload: &Value) -> Result<Value, String> {
    let repo_url = required_str(payload, "repoUrl")?;
    let branch = required_str(payload, "branch")?;
    let port = payload
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| "run_web payload is missing 'port'".to_string())? as u16;
    let compose_path = payload.get("composePath").and_then(Value::as_str);
    let project_dir = ensure_repo(&repo_url, &branch).await?;
    let strategy = detect_run_strategy(&project_dir, compose_path)?;
    run_strategy(&strategy, &project_dir, port).await?;
    let url = format!("http://127.0.0.1:{port}");
    if !wait_for_http(&url).await {
        return Err(format!("{url} did not respond within 30s"));
    }
    let _ = open::that_detached(&url); // best-effort — failure isn't fatal
    Ok(json!({ "url": url, "port": port, "projectDir": project_dir }))
}

fn required_str(payload: &Value, key: &str) -> Result<String, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("run_web payload is missing '{key}'"))
}

enum RunStrategy {
    Compose(String),
    Dockerfile,
}

/// composePath (from the command) wins; then default compose names in
/// priority order; then a root Dockerfile; else an error.
fn detect_run_strategy(project_dir: &Path, compose_path: Option<&str>) -> Result<RunStrategy, String> {
    if let Some(file) = compose_path {
        return Ok(RunStrategy::Compose(file.to_string()));
    }
    let entries = std::fs::read_dir(project_dir).map_err(|e| format!("cannot read repo dir: {e}"))?;
    let names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    for candidate in COMPOSE_CANDIDATES {
        if names.iter().any(|name| name == candidate) {
            return Ok(RunStrategy::Compose(candidate.to_string()));
        }
    }
    if names.iter().any(|name| name == "Dockerfile") {
        return Ok(RunStrategy::Dockerfile);
    }
    Err("No compose file or Dockerfile found at repo root".to_string())
}

async fn run_strategy(strategy: &RunStrategy, project_dir: &Path, port: u16) -> Result<(), String> {
    match strategy {
        RunStrategy::Compose(file) => {
            run("docker", &["compose", "-f", file, "up", "-d", "--build"], Some(project_dir))
                .await?;
        }
        RunStrategy::Dockerfile => run_with_dockerfile(project_dir, port).await?,
    }
    Ok(())
}

async fn run_with_dockerfile(project_dir: &Path, port: u16) -> Result<(), String> {
    let name = project_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string());
    let tag: String = format!("lemniscate-{name}").chars().take(60).collect();
    run("docker", &["build", "-t", &tag, "."], Some(project_dir)).await?;
    // Best-effort replace of a previous run.
    let _ = run("docker", &["rm", "-f", &tag], None).await;
    let mapping = format!("{port}:{port}");
    run("docker", &["run", "-d", "--name", &tag, "-p", &mapping, &tag], Some(project_dir)).await?;
    Ok(())
}

// --- repo checkout -----------------------------------------------------------

fn repos_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".lemniscate-agent")
        .join("repos")
}

fn repo_dir_for(repo_url: &str) -> PathBuf {
    repos_root().join(protocol::repo_dir_name(repo_url))
}

/// Clone (or fetch + hard-reset) the repo into the repos dir.
async fn ensure_repo(repo_url: &str, branch: &str) -> Result<PathBuf, String> {
    let dir = repo_dir_for(repo_url);
    let dir_str = dir.to_string_lossy().into_owned();
    if dir.join(".git").exists() {
        run("git", &["-C", &dir_str, "fetch", "--depth", "1", "origin", branch], None).await?;
        run("git", &["-C", &dir_str, "reset", "--hard", "FETCH_HEAD"], None).await?;
        return Ok(dir);
    }
    std::fs::create_dir_all(repos_root()).map_err(|e| format!("cannot create repos dir: {e}"))?;
    run("git", &["clone", "--depth", "1", "--branch", branch, repo_url, &dir_str], None).await?;
    Ok(dir)
}

// --- process / http helpers ----------------------------------------------------

/// Run a process; on failure the error carries the tail of its output.
async fn run(program: &str, args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    let output = command
        .output()
        .await
        .map_err(|e| format!("failed to spawn {program}: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        let tail = protocol::tail_log(&text, 2048);
        return Err(format!("{} {} failed: {tail}", program, args.first().unwrap_or(&"")));
    }
    Ok(text)
}

/// Poll until the app answers HTTP (any status counts) or the timeout hits.
async fn wait_for_http(url: &str) -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_default();
    let deadline = Instant::now() + HTTP_READY_TIMEOUT;
    while Instant::now() < deadline {
        if client.get(url).send().await.is_ok() {
            return true;
        }
        tokio::time::sleep(HTTP_POLL_INTERVAL).await;
    }
    false
}
