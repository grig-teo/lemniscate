//! Command execution: dispatch server-pushed commands to the per-command
//! executor modules (full parity with the Node agent's executeCommand).
//! Shared plumbing — the command_result envelope, step logging, process
//! spawning, repo checkout — lives in `exec.rs`.

use serde_json::Value;

use crate::build_android;
use crate::config::Config;
use crate::exec::{CommandContext, ResultSender};
use crate::install_apk;
use crate::run_desktop;
use crate::run_ios;
use crate::run_web;

/// Entry point from the tunnel read loop; runs one command to completion.
pub async fn execute(
    tx: ResultSender,
    config: Config,
    id: String,
    command_type: String,
    payload: Value,
) {
    match command_type.as_str() {
        "run_web" => run_web::execute(tx, config, id, payload).await,
        "install_apk" => install_apk::execute(tx, config, id, payload).await,
        "build_android" => build_android::execute(tx, config, id, payload).await,
        "run_desktop" => run_desktop::execute(tx, config, id, payload).await,
        "run_ios" => run_ios::execute(tx, config, id, payload).await,
        // protocol.rs already rejects unknown types; this is defense in depth.
        other => CommandContext::new(tx, id).fail(format!("'{other}' is not supported by this agent")).await,
    }
}
