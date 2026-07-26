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
        let log = protocol::tail_log(&self.log, 2048);
        self.send("failed", Some(json!({ "error": error, "log": log }))).await;
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
