//! `run_web`: clone/pull the repo, bring it up with compose or a Dockerfile,
//! wait for HTTP, open the browser. Parity with executeRunWeb in agent/index.js.

use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

use crate::exec::{self, CommandContext, ResultSender, DEFAULT_CMD_TIMEOUT};

const HTTP_READY_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_POLL_INTERVAL: Duration = Duration::from_secs(1);
const COMPOSE_CANDIDATES: [&str; 4] = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
];

pub async fn execute(tx: ResultSender, id: String, payload: Value) {
    let mut ctx = CommandContext::new(tx, id);
    ctx.running().await;
    match attempt(&mut ctx, &payload).await {
        Ok(result) => ctx.done(result).await,
        Err(error) => ctx.fail(error).await,
    }
}

async fn attempt(ctx: &mut CommandContext, payload: &Value) -> Result<Value, String> {
    let repo_url = exec::required_str(payload, "repoUrl", "run_web")?;
    let branch = exec::required_str(payload, "branch", "run_web")?;
    let port = payload
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| "run_web payload is missing 'port'".to_string())? as u16;
    let project_dir = exec::ensure_repo(ctx, &repo_url, &branch).await?;
    let strategy = detect_run_strategy(&project_dir, payload.get("composePath").and_then(Value::as_str))?;
    run_strategy(ctx, &strategy, &project_dir, port).await?;
    let url = format!("http://127.0.0.1:{port}");
    if !wait_for_http(&url).await {
        return Err(format!("{url} did not respond within 30s"));
    }
    let _ = open::that_detached(&url); // best-effort — failure isn't fatal
    Ok(json!({ "url": url, "port": port, "projectDir": project_dir }))
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

async fn run_strategy(
    ctx: &mut CommandContext,
    strategy: &RunStrategy,
    project_dir: &Path,
    port: u16,
) -> Result<(), String> {
    match strategy {
        RunStrategy::Compose(file) => {
            ctx.step("docker", &["compose", "-f", file, "up", "-d", "--build"], Some(project_dir), DEFAULT_CMD_TIMEOUT).await?;
        }
        RunStrategy::Dockerfile => run_with_dockerfile(ctx, project_dir, port).await?,
    }
    Ok(())
}

async fn run_with_dockerfile(ctx: &mut CommandContext, project_dir: &Path, port: u16) -> Result<(), String> {
    let name = project_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string());
    let tag: String = format!("lemniscate-{name}").chars().take(60).collect();
    ctx.step("docker", &["build", "-t", &tag, "."], Some(project_dir), DEFAULT_CMD_TIMEOUT).await?;
    // Best-effort replace of a previous run.
    let _ = exec::run_capture("docker", &["rm", "-f", &tag], None, DEFAULT_CMD_TIMEOUT).await;
    let mapping = format!("{port}:{port}");
    ctx.step("docker", &["run", "-d", "--name", &tag, "-p", &mapping, &tag], Some(project_dir), DEFAULT_CMD_TIMEOUT).await?;
    Ok(())
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
